import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WEBVIEW_CMD_CHANNEL,
  WEBVIEW_PROTO_CHANNEL,
} from '../../shared/protocol';
import type {
  AgentCommand,
  AgentMessage,
  ProbeResult,
  ProtocolEntry,
  ProtocolPacket,
  SocketEvent,
} from '../../shared/protocol';
import { bytesToBase64 } from './decode';

/** Quantas entradas ficam em memória. Acima disso as mais antigas são descartadas. */
const MAX_ENTRIES = 5000;
/** Renderizações no máximo a cada N ms, mesmo com centenas de pacotes por segundo. */
const RENDER_THROTTLE_MS = 120;

export interface WebviewLike extends HTMLElement {
  send?: (channel: string, ...args: unknown[]) => void;
}

interface IpcMessageEvent extends Event {
  channel: string;
  args: unknown[];
}

export interface ProtocolCaptureState {
  entries: ProtocolEntry[];
  /** true quando o agente já avisou que está ativo na página atual. */
  agentReady: boolean;
  paused: boolean;
  probe: ProbeResult | null;
  sockets: SocketEvent[];
  lastError: string | null;
  totalIn: number;
  totalOut: number;
}

export interface ProtocolCaptureApi extends ProtocolCaptureState {
  setPaused: (paused: boolean) => void;
  clear: () => void;
  addMarker: (text: string) => void;
  requestProbe: () => void;
  /** Envia um pacote (header + corpo) pela conexão ativa do jogo. */
  sendPacket: (header: number, body: Uint8Array) => void;
  /** Reenvia um pacote capturado (usa o corpo capturado; falha se estava truncado). */
  replay: (packet: ProtocolPacket) => boolean;
}

/**
 * Recebe o tráfego do agente injetado no webview (via `ipc-message`) e mantém um
 * buffer circular de entradas para a aba Protocolo. Também expõe os comandos de volta.
 */
/**
 * `webviewEl` deve vir de um ref de callback (estado), para que os listeners sejam
 * registrados no momento em que o <webview> monta — e não quando a URL muda, o que
 * deixava a interface surda se o elemento montasse depois (ex.: preload chegando tarde).
 */
export function useProtocolCapture(
  webviewEl: WebviewLike | null,
  webviewSrc: string,
  onPacket?: (packet: ProtocolPacket) => void,
): ProtocolCaptureApi {
  const onPacketRef = useRef(onPacket);
  useEffect(() => {
    onPacketRef.current = onPacket;
  }, [onPacket]);
  const entriesRef = useRef<ProtocolEntry[]>([]);
  const countersRef = useRef({ in: 0, out: 0 });
  const dirtyRef = useRef(false);
  const localSeqRef = useRef(0);
  // Snapshot imutável do buffer para o React; atualizado no máximo a cada RENDER_THROTTLE_MS.
  const [snapshot, setSnapshot] = useState<{ entries: ProtocolEntry[]; totalIn: number; totalOut: number }>({
    entries: [],
    totalIn: 0,
    totalOut: 0,
  });
  const [agentReady, setAgentReady] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [sockets, setSockets] = useState<SocketEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const push = useCallback((entry: ProtocolEntry) => {
    const arr = entriesRef.current;
    arr.push(entry);
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
    dirtyRef.current = true;
  }, []);

  // Render throttle: um único setState por janela de tempo, com cópia rasa do buffer.
  useEffect(() => {
    const id = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setSnapshot({
        entries: entriesRef.current.slice(),
        totalIn: countersRef.current.in,
        totalOut: countersRef.current.out,
      });
    }, RENDER_THROTTLE_MS);
    return () => clearInterval(id);
  }, []);

  const sendCommand = useCallback(
    (cmd: AgentCommand) => {
      if (!webviewEl?.send) return;
      try {
        webviewEl.send(WEBVIEW_CMD_CHANNEL, cmd);
      } catch {
        /* webview ainda não anexado */
      }
    },
    [webviewEl],
  );

  // Escuta mensagens do preload do webview.
  useEffect(() => {
    if (!webviewSrc) return;
    const w = webviewEl;
    if (!w?.addEventListener) return;

    const onMessage = (ev: Event) => {
      const e = ev as IpcMessageEvent;
      if (e.channel !== WEBVIEW_PROTO_CHANNEL) return;
      const msg = e.args?.[0] as AgentMessage | undefined;
      if (!msg || msg.__hab !== true) return;
      switch (msg.type) {
        case 'ready':
          setAgentReady(true);
          setLastError(null);
          push({ kind: 'marker', id: ++localSeqRef.current, t: msg.payload.t, text: 'Agente ativo em ' + msg.payload.href });
          break;
        case 'packets':
          for (const p of msg.payload) {
            if (p.dir === 'in') countersRef.current.in++;
            else countersRef.current.out++;
            push({ kind: 'packet', packet: p });
            onPacketRef.current?.(p);
          }
          break;
        case 'socket':
          setSockets((prev) => [...prev.slice(-19), msg.payload]);
          push({ kind: 'socket', id: ++localSeqRef.current, event: msg.payload });
          break;
        case 'probe':
          setProbe(msg.payload);
          break;
        case 'error':
          setLastError(msg.payload.message);
          push({ kind: 'marker', id: ++localSeqRef.current, t: msg.payload.t, text: 'Erro do agente: ' + msg.payload.message });
          break;
      }
    };

    // Nova página: o agente é reinjetado pelo preload; até ele avisar, consideramos inativo.
    const onDidNavigate = () => setAgentReady(false);

    w.addEventListener('ipc-message', onMessage);
    w.addEventListener('did-navigate', onDidNavigate);
    return () => {
      w.removeEventListener('ipc-message', onMessage);
      w.removeEventListener('did-navigate', onDidNavigate);
    };
  }, [webviewSrc, webviewEl, push]);

  const setPaused = useCallback(
    (p: boolean) => {
      setPausedState(p);
      sendCommand({ type: p ? 'pause' : 'resume' });
    },
    [sendCommand],
  );

  const clear = useCallback(() => {
    entriesRef.current = [];
    countersRef.current = { in: 0, out: 0 };
    dirtyRef.current = true;
  }, []);

  const addMarker = useCallback(
    (text: string) => {
      push({ kind: 'marker', id: ++localSeqRef.current, t: Date.now(), text });
      window.habblet?.protocol.marker(text).catch(() => {});
    },
    [push],
  );

  const requestProbe = useCallback(() => sendCommand({ type: 'probe' }), [sendCommand]);

  const sendPacket = useCallback(
    (header: number, body: Uint8Array) => {
      sendCommand({ type: 'send', header, bodyBase64: bytesToBase64(body) });
    },
    [sendCommand],
  );

  const replay = useCallback(
    (packet: ProtocolPacket) => {
      if (packet.truncated || packet.header < 0) return false;
      sendCommand({ type: 'send', header: packet.header, bodyBase64: packet.body });
      return true;
    },
    [sendCommand],
  );

  return {
    entries: snapshot.entries,
    agentReady,
    paused,
    probe,
    sockets,
    lastError,
    totalIn: snapshot.totalIn,
    totalOut: snapshot.totalOut,
    setPaused,
    clear,
    addMarker,
    requestProbe,
    sendPacket,
    replay,
  };
}
