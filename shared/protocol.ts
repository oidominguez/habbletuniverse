/**
 * Tipos da camada de protocolo: o que o agente injetado na página do jogo
 * reporta ao app e os comandos que o app envia de volta.
 *
 * Fluxo: página (main world, agente) → window.postMessage → preload do webview
 * (isolated world) → ipcRenderer.sendToHost → renderer (evento `ipc-message`).
 * E no sentido inverso: renderer → webview.send('hab:cmd') → preload → postMessage → agente.
 *
 * Só tipos e constantes puras aqui.
 */

/** Canal usado por `ipcRenderer.sendToHost` (guest → renderer). */
export const WEBVIEW_PROTO_CHANNEL = 'hab:proto';
/** Canal usado por `webview.send` (renderer → guest). */
export const WEBVIEW_CMD_CHANNEL = 'hab:cmd';
/** Parâmetros do Turnstile capturados na página (preload → renderer). */
export const WEBVIEW_CF_CHANNEL = 'hab:cf';
/** Canal usado pelo preload do webview para mandar uma cópia de tudo ao processo principal (gravação em disco). */
export const WEBVIEW_RECORD_CHANNEL = 'hab:proto:record';

export type PacketDirection = 'in' | 'out';

/**
 * Um pacote do protocolo Habbo/Nitro: `int32 length` + `int16 header` + corpo.
 * `header` -1 = bytes que não fecharam um frame válido (possível criptografia ou framing diferente);
 * `header` -2 = mensagem de texto (não binária).
 */
export interface ProtocolPacket {
  id: number;
  /** Date.now() no momento da captura. */
  t: number;
  dir: PacketDirection;
  socketId: number;
  header: number;
  /** Tamanho declarado no frame (header + corpo). */
  length: number;
  /** Tamanho real do corpo capturado antes do corte. */
  bodyLength: number;
  /** Corpo em base64 (pode estar truncado; ver `truncated`). */
  body: string;
  truncated: boolean;
  /** true quando o pacote foi enviado pelo próprio app (replay / envio manual), não pelo cliente. */
  injected?: boolean;
  /** true para os casos header -1/-2. */
  raw?: boolean;
  /** true quando o corpo foi omitido por ser sensível (SSO ticket, machine id). */
  redacted?: boolean;
}

export interface SocketEvent {
  /** `intercepted` = modo sem tela: o agente devolveu um socket falso ao cliente Nitro em vez de conectar. */
  event: 'open-attempt' | 'open' | 'close' | 'error' | 'intercepted';
  socketId: number;
  url?: string;
  code?: number;
  reason?: string;
  t: number;
}

/** Resultado da sondagem dos internos do cliente (globais expostos, URL do socket etc.). */
export interface ProbeResult {
  t: number;
  href: string;
  /** Nome do global → typeof. Ex.: { NitroConfig: 'object' } */
  found: Record<string, string>;
  socketUrl: string | null;
  openSockets: number;
  /** Chaves do NitroConfig, quando existe (ajuda a achar headers/customizações do hotel). */
  nitroConfigKeys?: string[];
}

/** Um pacote de saída capturado com o corpo completo (sem redação): só usado pelo handshake do modo sem tela. */
export interface HandshakePacket {
  header: number;
  bodyBase64: string;
}

/**
 * Handshake que o cliente Nitro tentou enviar (4096 versão, 2490 machine id, 2419 ticket SSO) quando o
 * agente estava em modo de interceptação. **Sensível** (contém o ticket): vai só para o renderer, nunca
 * para o arquivo de captura.
 */
export interface InterceptedHandshake {
  t: number;
  url: string;
  origin: string;
  userAgent: string;
  packets: HandshakePacket[];
}

/** Mensagens do agente para o app. */
export type AgentMessage =
  | { __hab: true; type: 'ready'; payload: { t: number; href: string; intercepting: boolean } }
  | { __hab: true; type: 'packets'; payload: ProtocolPacket[] }
  | { __hab: true; type: 'socket'; payload: SocketEvent }
  | { __hab: true; type: 'probe'; payload: ProbeResult }
  | { __hab: true; type: 'handshake'; payload: InterceptedHandshake }
  | { __hab: true; type: 'error'; payload: { message: string; t: number } };

/** Chave em `sessionStorage` da página que arma a interceptação antes mesmo do agente receber o comando (sobrevive a reload). */
export const INTERCEPT_STORAGE_KEY = '__hab_intercept';

/** Comandos do app para o agente. */
export type AgentCommand =
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'probe' }
  /**
   * Modo sem tela: a partir de agora, `new WebSocket` do cliente devolve um socket falso que "abre",
   * captura o handshake e o entrega ao app (mensagem `handshake`); nada sai para a rede pela página.
   */
  | { type: 'intercept'; enabled: boolean }
  /** Monta e envia um pacote: header + corpo (base64) na conexão ativa. */
  | { type: 'send'; header: number; bodyBase64: string }
  /** Envia bytes crus (já com framing) na conexão ativa. */
  | { type: 'sendRaw'; base64: string };

/** Entrada da lista da aba Protocolo: pacote, evento de socket ou marcador manual do usuário. */
export type ProtocolEntry =
  | { kind: 'packet'; packet: ProtocolPacket }
  | { kind: 'socket'; id: number; event: SocketEvent }
  | { kind: 'marker'; id: number; t: number; text: string };

/** Chave de rótulo de header: direção + número, ex. "out:1234". */
export function headerLabelKey(dir: PacketDirection, header: number): string {
  return `${dir}:${header}`;
}
