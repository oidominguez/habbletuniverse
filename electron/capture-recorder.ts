import { app, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Nome da partition do webview remetente (pasta em `Partitions/`): 'habblet' = janela principal, 'crowd-<id>' = Multidão. */
function sourceOf(sender: WebContents): string {
  try {
    const sp = sender.session.storagePath ?? '';
    const m = sp.match(/Partitions[\\/]([^\\/]+)$/);
    return m ? m[1] : 'default';
  } catch {
    return '?';
  }
}
import { IPC } from '../shared/ipc';
import { WEBVIEW_RECORD_CHANNEL } from '../shared/protocol';
import type { AgentMessage } from '../shared/protocol';

/**
 * Grava a captura do protocolo em disco, uma linha JSON por evento (NDJSON), num arquivo
 * por sessão do app em `<userData>/captures/`. `captures/latest.txt` aponta para o arquivo
 * atual, para ferramentas externas acompanharem em tempo real (tail).
 *
 * Linhas possíveis:
 *   {"kind":"packet", ...ProtocolPacket}
 *   {"kind":"socket", ...SocketEvent}
 *   {"kind":"probe",  ...ProbeResult}
 *   {"kind":"ready",  t, href}
 *   {"kind":"error",  t, message}
 *   {"kind":"marker", t, text}        ← marcador digitado pelo usuário na aba Protocolo
 *   {"kind":"session", t, event: "start" | "end"}
 */
export class CaptureRecorder {
  private stream: fs.WriteStream | null = null;
  private filePath = '';

  start(): void {
    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(dir, `protocol-${stamp}.ndjson`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    fs.writeFileSync(path.join(dir, 'latest.txt'), this.filePath, 'utf8');
    this.write({ kind: 'session', t: Date.now(), event: 'start' });

    // `src` = de qual webview veio: 'habblet' (janela principal) ou 'crowd-<id>' (conta da Multidão).
    ipcMain.on(WEBVIEW_RECORD_CHANNEL, (event, msg: AgentMessage) => this.record(msg, sourceOf(event.sender)));
    ipcMain.handle(IPC.PROTO_MARKER, (_event, text: unknown) => {
      this.write({ kind: 'marker', t: Date.now(), text: typeof text === 'string' ? text.slice(0, 500) : '' });
    });
    ipcMain.handle(IPC.PROTO_CAPTURE_PATH, () => this.filePath);

    app.on('before-quit', () => this.stop());
  }

  stop(): void {
    if (!this.stream) return;
    this.write({ kind: 'session', t: Date.now(), event: 'end' });
    this.stream.end();
    this.stream = null;
  }

  private record(msg: AgentMessage, src: string): void {
    if (!msg || msg.__hab !== true) return;
    switch (msg.type) {
      case 'packets':
        for (const p of msg.payload) this.write({ kind: 'packet', src, ...p });
        break;
      case 'socket':
        this.write({ kind: 'socket', src, ...msg.payload });
        break;
      case 'probe':
        this.write({ kind: 'probe', src, ...msg.payload });
        break;
      case 'ready':
        this.write({ kind: 'ready', src, ...msg.payload });
        break;
      case 'error':
        this.write({ kind: 'error', src, ...msg.payload });
        break;
    }
  }

  private write(obj: unknown): void {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify(obj) + '\n');
    } catch {
      /* disco cheio ou stream fechado: não derruba o app */
    }
  }
}
