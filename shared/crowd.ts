/**
 * Multidão: várias contas do Habblet controladas pelo dashboard, cada uma numa sessão
 * de jogo própria (webview com partition isolada). Só tipos e constantes puras aqui.
 */

/** Conta como o renderer a vê: sem senha. */
export interface CrowdAccount {
  id: string;
  username: string;
  label: string;
  createdAt: number;
  /** Conectar automaticamente ao abrir o app. */
  autoConnect: boolean;
  /** Proxy da conta, sem credenciais (ex.: `socks5://1.2.3.4:1080 (auth)`); null = conexão direta. */
  proxy: string | null;
}

export interface CrowdAccountInput {
  username: string;
  password: string;
  label?: string;
  /** URL completa do proxy, com credenciais se houver. */
  proxy?: string;
}

export interface CrowdAccountPatch {
  username?: string;
  password?: string;
  label?: string;
  autoConnect?: boolean;
  /** URL completa do proxy; string vazia remove. */
  proxy?: string;
}

/** `via` diz por onde o teste saiu: pelo proxy da conta (o IP que o jogo vê) ou direto (sem proxy = IP real). */
export type ProxyTestResult = { ok: true; ip: string; via: 'proxy' | 'direto' } | { ok: false; error: string };

/** Serviço de resolução de captcha (chave do usuário). */
export type CaptchaSolverProvider = 'none' | '2captcha' | 'capsolver';

export interface CaptchaSolverSettings {
  provider: CaptchaSolverProvider;
  /** Só indica se há chave guardada; a chave em si fica criptografada no main. */
  hasKey: boolean;
}

export interface TurnstileSolveRequest {
  url: string;
  sitekey: string;
  action?: string;
  cdata?: string;
  /** Presente só na página de desafio do Cloudflare (interstitial): `chlPageData` do widget. */
  pagedata?: string;
  /** User agent do webview; o token do desafio só vale para o mesmo UA. */
  userAgent?: string;
}

/** Parâmetros capturados do `turnstile.render` na página (hook do preload). */
export interface TurnstileRenderParams extends TurnstileSolveRequest {
  /** true = interstitial do Cloudflare (antes do site); false = widget do formulário de login. */
  challenge: boolean;
}

export type TurnstileSolveResult = { ok: true; token: string; elapsedMs: number } | { ok: false; error: string };

/** Modo Tor: uma porta SOCKS por conta (IP de saída diferente por conta, grátis). */
export interface TorSettings {
  enabled: boolean;
  host: string;
  /** Primeira SocksPort; a conta de índice i usa basePort + i. */
  basePort: number;
  /** Quantas portas gerar no torrc (>= número de contas). */
  count: number;
  /** Caminho do tor.exe; vazio tenta o `tor` do PATH. */
  torExePath: string | null;
}

export interface TorStatus {
  running: boolean;
  torrcPath: string;
  error: string | null;
  /** tor.exe detectado/usado (null = não encontrado). */
  torExe: string | null;
}

/* ------------------------------------ rede e transporte ------------------------------------ */

/**
 * Como cada conta fala com o jogo depois do login.
 *  - `headless`: o webview só faz o login e entrega o ticket; um cliente Node no processo principal
 *    conecta ao WebSocket pelo proxy da conta e o webview é destruído. Sem cliente Nitro, sem assets,
 *    sem WebGL: só protocolo.
 *  - `webview`: o cliente Nitro completo roda na tela da conta (modo antigo).
 */
export type CrowdTransportMode = 'headless' | 'webview';

export interface CrowdNetworkSettings {
  mode: CrowdTransportMode;
  /** `game-only`: só os hosts do jogo/site saem pelo proxy (PAC); o resto (assets) vai direto. `all`: tudo pelo proxy. */
  proxyScope: 'all' | 'game-only';
  /** Hosts (e subdomínios) que devem sair pelo proxy no escopo `game-only`. */
  gameHosts: string[];
  /** Modo sem tela: se a conexão do jogo cair, refaz o login sozinho depois de alguns segundos. */
  autoReconnect: boolean;
  /**
   * Login pelo IP real (o Habblet/Cloudflare implica com VPN e proxy na hora do login) e proxy só
   * depois de autenticado, para o WebSocket do jogo. Sem tela: a página do login fica direta e o
   * cliente Node conecta pelo proxy. Com tela: o proxy é aplicado à sessão (só `game.habblet.city`)
   * antes de abrir o /hotel. Risco: se o servidor amarrar o ticket ao IP do login, o handshake é recusado.
   */
  proxyAfterLogin: boolean;
  /**
   * Fila de conexão: quantas contas fazem login ao mesmo tempo em "Conectar todas" e na conexão automática.
   * A próxima entra quando uma autentica, falha ou cai no captcha. Dez logins simultâneos pelo mesmo
   * provedor derrubavam metade (Cloudflare, memória, IP rotativo); 2 por vez entram todas (18/09/2026).
   */
  connectConcurrency: number;
}

export const DEFAULT_GAME_HOSTS = ['habblet.city', 'game.habblet.city', 'challenges.cloudflare.com'];
/** Só o WebSocket do jogo: usado no "proxy depois do login". */
export const GAME_SOCKET_HOSTS = ['game.habblet.city'];

export const defaultCrowdNetworkSettings: CrowdNetworkSettings = {
  mode: 'headless',
  proxyScope: 'game-only',
  gameHosts: DEFAULT_GAME_HOSTS,
  autoReconnect: true,
  proxyAfterLogin: false,
  connectConcurrency: 2,
};

/** Em que momento o proxy da conta está sendo aplicado à sessão. */
export type ProxyPhase = 'login' | 'game';

export interface AppliedProxyInfo {
  /** Regras aplicadas sem credenciais, ou null = conexão direta. */
  rules: string | null;
  scope: 'all' | 'game-only' | 'direct';
  /** true quando a fase de login ficou direta de propósito e o proxy entra só depois (headless ou fase `game`). */
  deferred: boolean;
  /** Aviso para o painel (proxy recusou usuário/senha, não respondeu…). */
  warning?: string;
}

/** Um pacote do jogo como o cliente headless o entrega ao renderer (mesma forma do agente). */
import type { HandshakePacket, InterceptedHandshake, ProtocolPacket } from './protocol';
export type { HandshakePacket, InterceptedHandshake };

/** Eventos do cliente headless (main → renderer), sempre com o id da conta. */
export type HeadlessEvent =
  | { id: string; kind: 'open'; t: number }
  | { id: string; kind: 'close'; t: number; code: number; reason: string; byUser: boolean }
  | { id: string; kind: 'error'; t: number; message: string }
  | { id: string; kind: 'packets'; packets: ProtocolPacket[] }
  | { id: string; kind: 'stats'; bytesIn: number; bytesOut: number };

export interface HeadlessStatus {
  connected: boolean;
  bytesIn: number;
  bytesOut: number;
}

/** Tráfego HTTP (aproximado, por content-length) de uma partition, por host. */
export interface TrafficHostStat {
  host: string;
  bytes: number;
  requests: number;
  /** true quando, pelas regras atuais, este host sai pelo proxy. */
  viaProxy: boolean;
}

export interface TrafficReport {
  accountId: string;
  since: number;
  /** false quando o medidor HTTP está desligado nesta conta (proxy com senha; ver electron/crowd-proxy.ts). */
  metered: boolean;
  /** Bytes de respostas HTTP que saíram pelo proxy / direto. Não inclui o WebSocket do jogo. */
  bytesViaProxy: number;
  bytesDirect: number;
  requests: number;
  hosts: TrafficHostStat[];
  /** Bytes do WebSocket do jogo no modo sem tela (entrada + saída), quando houver. */
  headless: HeadlessStatus | null;
}

/** Credenciais em claro, entregues ao renderer só no momento de preencher o login. */
export interface CrowdCredentials {
  username: string;
  password: string;
}

/** Estado de uma sessão de conta na Multidão. */
export type CrowdSessionStatus =
  | 'offline'
  | 'loading' // webview carregando o site
  | 'logging-in' // formulário preenchido, aguardando resposta
  | 'hotel' // em /hotel, aguardando o cliente conectar (2725)
  | 'online' // logado no jogo
  | 'captcha' // Cloudflare (Turnstile ou desafio) exige interação: resolver na tela da conta
  | 'error';

/** Página do hotel: entrada do jogo. */
export const HABBLET_HOME_URL = 'https://www.habblet.city/';
export const HABBLET_HOTEL_URL = 'https://www.habblet.city/hotel';

/** Partition do webview de uma conta (cookies/sessão isolados por conta). */
export function crowdPartition(accountId: string): string {
  return `persist:crowd-${accountId}`;
}
