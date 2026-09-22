/**
 * Cliente do jogo SEM TELA (processo principal). Conecta ao WebSocket do Habblet pelo proxy da conta,
 * reproduz o handshake que o cliente Nitro tentou mandar (capturado pelo agente em modo de interceptação)
 * e, daí em diante, é só protocolo: os pacotes vão para o renderer com a mesma forma dos do agente
 * (`ProtocolPacket`), então GameState, ações e motores não sabem a diferença.
 *
 * O que o Nitro faria sozinho (pong, rajada pós-login, sequência de entrada em quarto, seguir amigo)
 * está em `headless-protocol.ts` e é emulado aqui, para o servidor enxergar um cliente normal.
 */
import WebSocket from 'ws';
import type { ClientRequestArgs } from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { HandshakePacket, HeadlessEvent, HeadlessStatus } from '../shared/crowd';
import type { ProtocolPacket } from '../shared/protocol';
import { NitroClientEmulation, framePacket, parseFrames } from './headless-protocol';
import { agentUrl, parseProxy } from './proxy-url';

const MAX_BODY = 4 * 1024 * 1024;
const FLUSH_MS = 40;
const FLUSH_MAX = 200;
const STATS_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 20000;
/** Corpos que nunca saem do main em claro (ticket SSO e machine id). */
const SENSITIVE_OUT = new Set([2419, 2490]);

export interface HeadlessConnectOptions {
  id: string;
  url: string;
  origin: string;
  userAgent: string;
  cookie?: string;
  /** URL completa do proxy (com credenciais) ou null para conexão direta. */
  proxyUrl: string | null;
  handshake: HandshakePacket[];
  onEvent: (ev: HeadlessEvent) => void;
}

/** Agente HTTP para o `ws` conforme o esquema do proxy. Aqui o SOCKS5 com usuário/senha funciona (no Chromium não). */
export function agentFor(proxyUrl: string | null): ClientRequestArgs['agent'] | undefined {
  if (!proxyUrl) return undefined;
  const p = parseProxy(proxyUrl);
  if (p.scheme === 'socks5' || p.scheme === 'socks4') return new SocksProxyAgent(agentUrl(p));
  return new HttpsProxyAgent(agentUrl(p));
}

export class HeadlessGameClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private carry: Buffer = Buffer.alloc(0);
  private queue: ProtocolPacket[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private bytesIn = 0;
  private bytesOut = 0;
  private lastStats = { in: -1, out: -1 };
  private closedByUser = false;
  private readonly emu = new NitroClientEmulation();

  constructor(private readonly o: HeadlessConnectOptions) {}

  get status(): HeadlessStatus {
    return { connected: this.ws?.readyState === WebSocket.OPEN, bytesIn: this.bytesIn, bytesOut: this.bytesOut };
  }

  connect(): void {
    const headers: Record<string, string> = { Origin: this.o.origin, 'User-Agent': this.o.userAgent };
    if (this.o.cookie) headers.Cookie = this.o.cookie;
    const ws = new WebSocket(this.o.url, {
      agent: agentFor(this.o.proxyUrl),
      headers,
      perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.o.onEvent({ id: this.o.id, kind: 'open', t: Date.now() });
      // Handshake exatamente como o cliente Nitro tentou mandar (versão, machine id, ticket).
      for (const p of this.o.handshake) this.sendRaw(p.header, Buffer.from(p.bodyBase64, 'base64'), true);
      this.statsTimer = setInterval(() => this.emitStats(), STATS_MS);
    });
    ws.on('message', (data: WebSocket.RawData) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      this.bytesIn += buf.length;
      this.onData(buf);
    });
    ws.on('close', (code, reason) => {
      this.stopTimers();
      this.flush();
      this.emitStats();
      this.o.onEvent({ id: this.o.id, kind: 'close', t: Date.now(), code, reason: reason.toString('utf8'), byUser: this.closedByUser });
    });
    ws.on('error', (e) => {
      this.o.onEvent({ id: this.o.id, kind: 'error', t: Date.now(), message: e.message });
    });
  }

  /** Envia um pacote montado pelo app (renderer). */
  send(header: number, body: Uint8Array): boolean {
    return this.sendRaw(header, Buffer.from(body.buffer, body.byteOffset, body.byteLength), true);
  }

  close(): void {
    this.closedByUser = true;
    this.stopTimers();
    try {
      this.ws?.close(1000, 'app');
    } catch {
      /* já fechado */
    }
    this.ws = null;
  }

  /* ------------------------------------ interno ------------------------------------ */

  private sendRaw(header: number, body: Buffer, fromApp: boolean): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame = framePacket(header, body);
    ws.send(frame);
    this.bytesOut += frame.length;
    this.emu.noteOutgoing(header, body);
    this.enqueue(this.toPacket('out', header, body, fromApp));
    return true;
  }

  private onData(buf: Buffer): void {
    const whole = this.carry.length ? Buffer.concat([this.carry, buf]) : buf;
    const { packets, rest } = parseFrames(whole);
    this.carry = Buffer.from(rest);
    for (const p of packets) {
      this.enqueue(this.toPacket('in', p.header, p.body, false));
      // O que o cliente Nitro responderia sozinho (pong, rajadas, entrada em quarto, seguir).
      for (const reply of this.emu.onIncoming(p.header, p.body)) this.sendRaw(reply.header, reply.body, false);
    }
  }

  private toPacket(dir: 'in' | 'out', header: number, body: Buffer, injected: boolean): ProtocolPacket {
    const sensitive = dir === 'out' && SENSITIVE_OUT.has(header);
    const p: ProtocolPacket = {
      id: ++this.seq,
      t: Date.now(),
      dir,
      socketId: 1,
      header,
      length: body.length + 2,
      bodyLength: body.length,
      body: sensitive ? '' : body.subarray(0, MAX_BODY).toString('base64'),
      truncated: !sensitive && body.length > MAX_BODY,
    };
    if (sensitive) p.redacted = true;
    if (injected) p.injected = true;
    return p;
  }

  private enqueue(p: ProtocolPacket): void {
    this.queue.push(p);
    if (this.queue.length >= FLUSH_MAX) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const packets = this.queue.splice(0, this.queue.length);
    this.o.onEvent({ id: this.o.id, kind: 'packets', packets });
  }

  private emitStats(): void {
    if (this.lastStats.in === this.bytesIn && this.lastStats.out === this.bytesOut) return;
    this.lastStats = { in: this.bytesIn, out: this.bytesOut };
    this.o.onEvent({ id: this.o.id, kind: 'stats', bytesIn: this.bytesIn, bytesOut: this.bytesOut });
  }

  private stopTimers(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }
}

/** Um cliente por conta. */
export class HeadlessRegistry {
  private clients = new Map<string, HeadlessGameClient>();

  connect(o: HeadlessConnectOptions): void {
    this.disconnect(o.id);
    const c = new HeadlessGameClient(o);
    this.clients.set(o.id, c);
    c.connect();
  }

  send(id: string, header: number, body: Uint8Array): boolean {
    return this.clients.get(id)?.send(header, body) ?? false;
  }

  disconnect(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    c.close();
  }

  status(id: string): HeadlessStatus | null {
    return this.clients.get(id)?.status ?? null;
  }

  disposeAll(): void {
    for (const id of [...this.clients.keys()]) this.disconnect(id);
  }
}
