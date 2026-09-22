/**
 * Log persistente do app em disco: `<userData>/logs/app-AAAA-MM-DD.log`, uma linha por evento.
 *
 * Recebe o que o renderer mostra no painel Logs (motores, Multidão) via IPC e o que o processo
 * principal registra por conta própria (cliente sem tela, proxy). Serve para diagnosticar sessões
 * longas sem depender da janela aberta, e para ferramentas externas acompanharem (tail).
 *
 * Nunca recebe segredos: senhas, tickets e chaves não passam por aqui.
 */
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../shared/ipc';

const MAX_LINE = 2000;
/** Acima disto o arquivo do dia é renomeado para `.1` e recomeça (evita crescer sem fim). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

let stream: fs.WriteStream | null = null;
let streamDay = '';
let streamPath = '';
let written = 0;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function ensureStream(): fs.WriteStream {
  const day = dayKey();
  if (stream && streamDay === day && written < MAX_FILE_BYTES) return stream;
  if (stream) {
    stream.end();
    stream = null;
  }
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `app-${day}.log`);
  if (streamDay === day && written >= MAX_FILE_BYTES) {
    try {
      fs.renameSync(file, file + '.1');
    } catch {
      /* ignora */
    }
  }
  streamDay = day;
  streamPath = file;
  written = fs.existsSync(file) ? fs.statSync(file).size : 0;
  stream = fs.createWriteStream(file, { flags: 'a' });
  fs.writeFileSync(path.join(dir, 'latest.txt'), file, 'utf8');
  return stream;
}

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Escreve uma linha: `HH:MM:SS.mmm [origem] mensagem`. */
export function appLog(source: string, message: string): void {
  try {
    const line = `${stamp()} [${source}] ${String(message).replace(/\r?\n/g, ' ').slice(0, MAX_LINE)}\n`;
    const s = ensureStream();
    s.write(line);
    written += Buffer.byteLength(line);
  } catch {
    /* disco cheio etc.: não derruba o app */
  }
}

export function appLogPath(): string {
  ensureStream();
  return streamPath;
}

/**
 * Log nativo do Chromium/Electron em `<userData>/logs/chromium.log`. Um CHECK/NOTREACHED do processo
 * principal (caso do ProxyingWebSocket em 17/09/2026) mata o app sem passar pelo appLog; a mensagem
 * FATAL só aparece aqui. O Electron apaga o arquivo a cada início, então o anterior vira
 * `chromium.prev.log`. Só WARNING para cima (o INFO traz o console do Nitro inteiro).
 * Precisa rodar antes do `ready`: os switches são lidos ao iniciar o log do processo principal.
 */
export function enableChromiumLog(): void {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'chromium.log');
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, 'chromium.prev.log'));
    app.commandLine.appendSwitch('enable-logging', 'file');
    app.commandLine.appendSwitch('log-file', file);
    app.commandLine.appendSwitch('log-level', '1');
  } catch {
    /* sem log nativo, segue */
  }
}

export function registerAppLog(): void {
  // Processos filhos (GPU, rede, utilitários) e renderers que caem: ficam no log com o motivo.
  app.on('child-process-gone', (_event, d) => appLog('app', `processo ${d.type}${d.name ? ' ' + d.name : ''} caiu: ${d.reason} exitCode=${d.exitCode}`));
  app.on('web-contents-created', (_event, wc) => {
    wc.on('render-process-gone', (_e, d) => appLog('app', `renderer caiu (${wc.getURL().slice(0, 100)}): ${d.reason} exitCode=${d.exitCode}`));
  });
  ipcMain.on(IPC.LOG_APPEND, (_event, source: unknown, message: unknown) => {
    if (typeof message !== 'string') return;
    appLog(typeof source === 'string' && source ? source.slice(0, 40) : 'renderer', message);
  });
  ipcMain.handle(IPC.LOG_PATH, () => appLogPath());
  appLog('app', `iniciado v${app.getVersion()} · electron ${process.versions.electron} · userData ${app.getPath('userData')}`);
  app.on('before-quit', () => {
    appLog('app', 'encerrando');
    stream?.end();
    stream = null;
  });
}
