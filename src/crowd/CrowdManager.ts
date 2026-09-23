/**
 * Multidão: gerencia N sessões de jogo (uma por conta), cada uma com seu webview isolado,
 * GameState, ações e motores por protocolo. Fora do React; a UI observa via `subscribe`.
 */
import type { AddonConfigMap, AddonId } from '../../shared/addon-config';
import type { AppliedProxyInfo, CrowdAccount, CrowdNetworkSettings, CrowdSessionStatus, CrowdTransportMode, HeadlessEvent, InterceptedHandshake, ProxyPhase } from '../../shared/crowd';
import { HABBLET_HOME_URL, HABBLET_HOTEL_URL, defaultCrowdNetworkSettings } from '../../shared/crowd';
import { INTERCEPT_STORAGE_KEY, WEBVIEW_CF_CHANNEL, WEBVIEW_CMD_CHANNEL, WEBVIEW_PROTO_CHANNEL } from '../../shared/protocol';
import type { AgentCommand, AgentMessage, ProtocolPacket } from '../../shared/protocol';
import { GameState } from '../protocol/state/GameState';
import { IN as H } from '../protocol/nitro/headers';
import { cleanName as cleanRoomName } from '../components/text';
import type { GameSnapshot } from '../protocol/state/GameState';
import { createGameActions } from '../protocol/actions';
import type { GameActions } from '../protocol/actions';
import { bytesToBase64 } from '../protocol/decode';
import { createEngineSet } from '../addons/protocol/engines';
import type { EngineSet, FollowConfig } from '../addons/protocol/engines';
import { postureSpots } from '../addons/protocol/postureEngine';
import type { Posture, PostureConfig } from '../addons/protocol/postureEngine';
import { approachTiles, tileKey } from '../addons/protocol/tiles';
import type { FurniCatalog } from '../../shared/furnidata';
import { ADDON_BY_ID } from '../addons/registry';
import { PROBE_LOGIN_JS, PROBE_TURNSTILE_JS, RESUME_LOGIN_JS, buildLoginJs, buildSubmitWithTokenJs } from './loginScript';
import type { LoginAttemptResult, LoginProbe, TurnstileInfo } from './loginScript';
import type { TurnstileRenderParams, TurnstileSolveRequest, TurnstileSolveResult } from '../../shared/crowd';

export type CrowdWebview = HTMLElement & {
  executeJavaScript: (c: string) => Promise<unknown>;
  getURL: () => string;
  loadURL?: (u: string) => Promise<void>;
  reload?: () => void;
  send?: (channel: string, ...args: unknown[]) => void;
  src?: string;
};

/**
 * Comandos do dashboard sobre uma, várias ou todas as contas. Cada um vira os pacotes correspondentes
 * na(s) sessão(ões) alvo; `pin`/`goTo` ligam o motor de perseguição da sessão.
 */
export type CrowdCommand =
  | { kind: 'enterRoom'; roomId: number }
  /** 3997 se o alvo for amigo da conta; senão o comando `:follow` do Habblet. */
  | { kind: 'followFriend'; name: string }
  | { kind: 'chat'; text: string }
  /** 2085 (header do Nitro padrão, ainda não confirmado neste hotel). */
  | { kind: 'shout'; text: string }
  | { kind: 'whisper'; nick: string; text: string }
  | { kind: 'walk'; x: number; y: number }
  | { kind: 'look'; x: number; y: number }
  /** Anda até ficar ao lado do usuário (uma vez). */
  | { kind: 'goTo'; name: string }
  /** Persegue o usuário em tempo real e dá follow quando ele troca de quarto. */
  | { kind: 'pin'; name: string }
  | { kind: 'unpin' }
  | { kind: 'requestFriend'; name: string }
  | { kind: 'acceptPending' }
  /** Quarteto do clique no avatar (3301+431+2091+2138). */
  | { kind: 'clickUser'; name: string }
  /** Respeitar o usuário pelo nick (2694). A confirmação (2815) aparece no log da conta. */
  | { kind: 'respect'; name: string }
  /** Pedir para entrar num grupo pelo id (998). */
  | { kind: 'joinGroup'; groupId: number }
  /** Dar nota ao quarto atual (3582). */
  | { kind: 'rateRoom' }
  /**
   * Copiar o visual de alguém pelo nick: pede o perfil ao servidor (2249 → 3898) e aplica o visual (2730).
   * Um caminho só, que serve para todos os casos: na sala, offline ou com a cópia "bloqueada" (a opção do
   * cliente só esconde o botão; a string do visual vem no perfil de qualquer forma). O gênero, que o perfil
   * não traz, vem da sala se a pessoa estiver nela; senão a conta mantém o seu.
   */
  | { kind: 'copyLook'; name: string }
  /** Aplicar uma string de visual direto (2730). */
  | { kind: 'setLook'; figure: string; gender?: string }
  /** Convidar os amigos de cada conta para o quarto em que ela está (1276), como o "selecionar todos" do console. */
  | { kind: 'inviteFriends'; message: string; onlineOnly: boolean }
  /** Mensagem no console (3567) para um amigo da conta, pelo nick. */
  | { kind: 'console'; name: string; text: string }
  /**
   * Todas sentadas / deitadas: cada conta procura um mobi sentável (ou deitável) livre e alcançável no quarto em
   * que está, anda até ele e o servidor a senta. As contas no mesmo quarto reservam casas diferentes.
   */
  | { kind: 'posture'; posture: Posture }
  /** Levantar: sai do mobi dando um passo para uma casa vizinha livre (e cancela a procura, se houver). */
  | { kind: 'standUp' }
  /** Para de procurar lugar (mantém quem já sentou). */
  | { kind: 'cancelPosture' };

export interface CommandResult {
  /** Em quantas contas o comando agiu. */
  count: number;
  /** Frase para o toast. */
  text: string;
}

/** Ponte com o cliente do jogo sem tela (processo principal), ligada pelo controlador React via IPC. */
export interface HeadlessBridge {
  connect(id: string, handshake: InterceptedHandshake): Promise<void>;
  send(id: string, header: number, bodyBase64: string): void;
  disconnect(id: string): Promise<void> | void;
}

export interface CrowdLogEntry {
  t: number;
  sessionId: string;
  username: string;
  msg: string;
}

export interface CrowdSessionView {
  id: string;
  account: CrowdAccount;
  status: CrowdSessionStatus;
  detail: string;
  agentReady: boolean;
  me: string | null;
  /** Código do visual da conta (2725), para a foto; null antes do login. */
  figure: string | null;
  roomName: string | null;
  roomId: number | null;
  roomUsers: number;
  pendingRequests: number;
  sent: number;
  /** Sessão pausada: webview segue conectado, motores e comandos em massa não agem. */
  paused: boolean;
  /** Regras de proxy aplicadas (sem credenciais) e IP de saída testado. */
  proxyRules: string | null;
  exitIp: string | null;
  /** `headless` = já conectada pelo cliente sem tela (a página do jogo foi descartada). */
  transport: CrowdTransportMode;
  /** Bytes do WebSocket do jogo no modo sem tela. */
  bytesIn: number;
  bytesOut: number;
  /** Perseguição ativa (fixar / ir até) e o que o motor está fazendo. */
  follow: FollowConfig | null;
  followStatus: string;
  /** Posição do avatar na sala (do 374/1640), quando conhecida. */
  pos: { x: number; y: number } | null;
  /** Postura atual do avatar (do 1640): sentada, deitada ou em pé. */
  posture: Posture | null;
  /** Procura de lugar em andamento (comando sentar/deitar) e o que o motor está fazendo. */
  postureTask: Posture | null;
  postureStatus: string;
}

export interface CrowdSnapshot {
  version: number;
  sessions: CrowdSessionView[];
  /** Ids das sessões que devem ter webview montado (conectadas e com proxy já aplicado). */
  connectedIds: string[];
  addonsEnabled: Record<AddonId, boolean>;
  logs: CrowdLogEntry[];
  /** Comandos de chat que o servidor anunciou (432) a alguma das contas, sem repetição. */
  commands: string[];
  /** Contas esperando a vez na fila de conexão, na ordem em que vão entrar. */
  queuedIds: string[];
  /** Contas que a fila soltou e ainda estão fazendo login (ocupam vaga). */
  connectingIds: string[];
}

interface Session {
  id: string;
  account: CrowdAccount;
  status: CrowdSessionStatus;
  detail: string;
  paused: boolean;
  webview: CrowdWebview | null;
  detach: (() => void) | null;
  state: GameState;
  actions: GameActions;
  engines: EngineSet;
  agentReady: boolean;
  /** Respeitos enviados e ainda sem o 2815 de volta: userId → quando. Só para confirmar no log. */
  respectPending: Map<number, number>;
  /** Perfis pedidos (2249) para copiar o visual quando o 3898 chegar: nick em minúsculas → quando. */
  lookPending: Map<string, number>;
  loginAttempts: number;
  loginInFlight: boolean;
  lastLoginAt: number;
  credentials: { username: string; password: string } | null;
  proxyRules: string | null;
  exitIp: string | null;
  captchaTimer: ReturnType<typeof setInterval> | null;
  /** Últimos parâmetros do Turnstile vistos na página atual (hook do preload). */
  cfParams: TurnstileRenderParams | null;
  /** Há uma resolução da página de desafio em andamento. */
  cfSolving: boolean;
  /** O webview só pode montar depois do proxy aplicado à partition. */
  ready: boolean;
  /** Por onde os pacotes passam: página do jogo (webview) ou cliente sem tela (main). */
  transport: CrowdTransportMode;
  /** Modo sem tela já autenticado: a página do jogo foi descartada (connectedIds não a inclui mais). */
  headlessActive: boolean;
  headlessBytes: { in: number; out: number };
  /** Quantas vezes recarregamos a página porque o Nitro conectou antes da interceptação. */
  interceptReloads: number;
  /** Refaz o login do zero (usado na reconexão automática do modo sem tela). */
  reconnect: (() => void) | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Há uma sondagem da página em andamento (o did-stop-loading dispara várias vezes por página). */
  probing: boolean;
  /** Última vez que o status/detalhe mudou: o vigia recarrega quando o login não avança. */
  lastProgressAt: number;
  /** Quantas vezes o vigia já reiniciou o login desta sessão. */
  stalls: number;
  /** Quantas vezes fomos ao /hotel e voltamos para o formulário (sessão web não estava autenticada). */
  hotelBounces: number;
  /** Perseguição ativa (comando fixar / ir até). */
  follow: FollowConfig | null;
  /** Procura de lugar para sentar/deitar (comando). */
  posture: PostureConfig | null;
  /** Aplica o proxy da conta numa fase (`game` = antes do hotel, no "proxy depois do login"). */
  applyProxy: ((id: string, phase: ProxyPhase) => Promise<AppliedProxyInfo>) | null;
  /** O proxy ficou adiado para depois do login (fase `login` direta). */
  proxyDeferred: boolean;
}

type Listener = () => void;
const TICK_MS = 250;
/** Fila de conexão: quanto esperar uma conta autenticar antes de liberar a vaga mesmo assim. */
const QUEUE_SETTLE_MS = 90_000;
/** Respiro entre uma conta liberar a vaga e a próxima começar (deixa o site/proxy respirar). */
const QUEUE_GAP_MS = 2_000;

interface QueueItem {
  id: string;
  getCredentials: (id: string) => Promise<{ username: string; password: string }>;
  applyProxy?: (id: string, phase: ProxyPhase) => Promise<AppliedProxyInfo>;
}
/** Pacotes que mexem na posição/presença de alguém na sala: disparam o Seguir na hora. */
const FOLLOW_TRIGGERS = new Set<number>([H.UNIT_STATUS, H.UNIT_REMOVE, H.ROOM_USERS]);
/** Idem para a procura de lugar: também reage a mobi colocado/removido/movido. */
const POSTURE_TRIGGERS = new Set<number>([H.UNIT_STATUS, H.UNIT_REMOVE, H.ROOM_USERS, H.ROOM_FLOOR_ITEMS, H.ROOM_FLOOR_ITEM_ADD, H.ROOM_FLOOR_ITEM_REMOVE, H.ROOM_FLOOR_ITEM_UPDATE]);
const LOG_CAP = 800;
const MAX_LOGIN_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 20000;
const MAX_INTERCEPT_RELOADS = 2;
/** Quanto esperar, sondando a cada 400 ms, o formulário / desafio / hotel aparecerem numa página lenta. */
const PAGE_SETTLE_MS = 30000;
const PAGE_POLL_MS = 400;
/** Vigia: sem progresso por este tempo em loading/logging-in, recomeça o login. */
const STALL_MS = 60000;
/** No hotel o cliente Nitro (MBs de bundle) pode levar bem mais para carregar e conectar: mais folga. */
const HOTEL_STALL_MS = 150000;
const MAX_STALLS = 3;
const MAX_HOTEL_BOUNCES = 2;
/** Falha de rede ao carregar: tenta de novo depois deste tempo. */
const RETRY_LOAD_MS = 10000;

export class CrowdManager {
  private sessions = new Map<string, Session>();
  private accounts: CrowdAccount[] = [];
  private configs: AddonConfigMap | null = null;
  private network: CrowdNetworkSettings = defaultCrowdNetworkSettings;

  /* ------------------------------------ fila de conexão ------------------------------------ */
  private queue: QueueItem[] = [];
  /** Ids que a fila liberou e ainda não autenticaram/falharam. */
  private readonly queueActive = new Set<string>();
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queuePumpTimer: ReturnType<typeof setTimeout> | null = null;
  private headlessBridge: HeadlessBridge | null = null;
  /** Catálogo de mobis sentáveis/deitáveis (furnidata), carregado pelo controlador via IPC. */
  private furniCatalog: FurniCatalog | null = null;
  /** Reservas de casa por quarto para o comando sentar/deitar: roomId → casa → sessão. */
  private readonly postureClaims = new Map<number, Map<string, string>>();
  private addonsEnabled: Record<AddonId, boolean> = { adduserall: false, automessage: false, autoreplywhispers: false, nudgeeveryone: false, consoletracker: false, autoaccept: false };
  private logs: CrowdLogEntry[] = [];
  private listeners = new Set<Listener>();
  private version = 0;
  private snapshotCache: CrowdSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Repassa logs também ao painel Logs da janela principal. */
  private externalLog: ((msg: string) => void) | null = null;
  private statusListener: ((accountId: string, status: CrowdSessionStatus, detail: string) => void) | null = null;
  /** Resolvedor de Turnstile (2Captcha / CapSolver) — null = só manual. */
  private solver: ((req: TurnstileSolveRequest) => Promise<TurnstileSolveResult>) | null = null;

  setSolver(fn: ((req: TurnstileSolveRequest) => Promise<TurnstileSolveResult>) | null): void {
    this.solver = fn;
  }

  /**
   * Avisa cada mudança de status de sessão (conta, status novo, detalhe). O controlador usa isto para o
   * pool de proxies aprender: online = o proxy passou; "login recusado" = o site (anti-VPN) barrou o proxy.
   */
  setStatusListener(fn: ((accountId: string, status: CrowdSessionStatus, detail: string) => void) | null): void {
    this.statusListener = fn;
  }

  setExternalLog(fn: ((msg: string) => void) | null): void {
    this.externalLog = fn;
  }

  setNetwork(settings: CrowdNetworkSettings): void {
    this.network = settings;
  }

  get networkSettings(): CrowdNetworkSettings {
    return this.network;
  }

  setHeadlessBridge(bridge: HeadlessBridge | null): void {
    this.headlessBridge = bridge;
  }

  setFurniCatalog(catalog: FurniCatalog | null): void {
    this.furniCatalog = catalog;
  }

  get hasFurniCatalog(): boolean {
    return this.furniCatalog !== null;
  }

  constructor() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) s.detach?.();
    this.sessions.clear();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ------------------------------------ contas ------------------------------------ */

  setAccounts(accounts: CrowdAccount[]): void {
    this.accounts = accounts;
    for (const s of this.sessions.values()) {
      const acc = accounts.find((a) => a.id === s.id);
      if (acc) s.account = acc;
    }
    for (const id of [...this.sessions.keys()]) if (!accounts.some((a) => a.id === id)) this.disconnect(id);
    this.bump();
  }

  setConfigs(configs: AddonConfigMap): void {
    this.configs = configs;
  }

  setAddonEnabled(id: AddonId, enabled: boolean): void {
    this.addonsEnabled = { ...this.addonsEnabled, [id]: enabled };
    this.log(null, `${ADDON_BY_ID[id].name} ${enabled ? 'ativado' : 'desativado'} para a multidão.`);
    this.bump();
  }

  /* ------------------------------------ sessões ------------------------------------ */

  /**
   * Marca a conta como conectada. Primeiro aplica o proxy à partition (senão o primeiro
   * request sairia pelo IP real); só então a UI monta o webview e chama `attachWebview`.
   */
  async connect(
    id: string,
    getCredentials: (id: string) => Promise<{ username: string; password: string }>,
    applyProxy?: (id: string, phase: ProxyPhase) => Promise<AppliedProxyInfo>,
  ): Promise<void> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account || this.sessions.has(id)) return;
    const state = new GameState();
    const s: Session = {
      id,
      account,
      status: 'loading',
      detail: 'abrindo o site',
      paused: false,
      webview: null,
      detach: null,
      state,
      // Sem cliente Nitro do outro lado (sem tela), "visitar" um quarto é mandar o 2312 direto.
      actions: createGameActions((header, body) => this.sendPacket(id, header, body), state, {
        directEnter: () => this.sessions.get(id)?.transport === 'headless',
      }),
      engines: createEngineSet(),
      transport: 'webview',
      headlessActive: false,
      headlessBytes: { in: 0, out: 0 },
      respectPending: new Map(),
      lookPending: new Map(),
      interceptReloads: 0,
      reconnect: () => {
        this.disconnect(id);
        void this.connect(id, getCredentials, applyProxy);
      },
      reconnectTimer: null,
      probing: false,
      lastProgressAt: Date.now(),
      stalls: 0,
      hotelBounces: 0,
      follow: null,
      posture: null,
      applyProxy: applyProxy ?? null,
      proxyDeferred: false,
      agentReady: false,
      loginAttempts: 0,
      loginInFlight: false,
      lastLoginAt: 0,
      credentials: null,
      proxyRules: null,
      exitIp: null,
      captchaTimer: null,
      cfParams: null,
      cfSolving: false,
      ready: false,
    };
    this.sessions.set(id, s);
    this.bump();
    try {
      s.credentials = await getCredentials(id);
    } catch (e) {
      this.setStatus(s, 'error', 'não foi possível ler a senha: ' + (e instanceof Error ? e.message : String(e)));
      return;
    }
    if (applyProxy) {
      try {
        const r = await applyProxy(id, 'login');
        s.proxyRules = r.rules;
        s.proxyDeferred = r.deferred;
        if (r.deferred) this.log(s, `login pelo IP real; o proxy ${r.rules} entra depois de autenticar, só na conexão do jogo (o site registra o IP real).`);
        else this.log(s, r.rules ? `proxy aplicado: ${r.rules}${r.scope === 'game-only' ? ' (só para o jogo; assets vão direto)' : ''}` : 'conexão direta (sem proxy)');
        if (r.warning) this.log(s, `⚠ ${r.warning}`);
      } catch (e) {
        this.setStatus(s, 'error', 'proxy inválido: ' + cleanErr(e));
        return;
      }
    }
    if (!this.sessions.has(id)) return; // desconectada enquanto aplicava o proxy
    s.ready = true;
    this.log(s, this.network.mode === 'headless' ? 'conectando… (modo sem tela: a página só faz o login)' : 'conectando…');
    this.bump();
  }

  setExitIp(id: string, ip: string | null): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.exitIp = ip;
    this.bump();
  }

  /**
   * Põe contas na fila de conexão. Só `network.connectConcurrency` fazem login ao mesmo tempo; a vaga é
   * liberada quando a conta fica online, dá erro, cai no captcha (espera o usuário) ou estoura o tempo.
   * Contas já conectadas ou já na fila são ignoradas.
   */
  enqueue(ids: string[], getCredentials: QueueItem['getCredentials'], applyProxy?: QueueItem['applyProxy']): number {
    let added = 0;
    for (const id of ids) {
      if (this.sessions.has(id) || this.queueActive.has(id) || this.queue.some((q) => q.id === id)) continue;
      if (!this.accounts.some((a) => a.id === id)) continue;
      this.queue.push({ id, getCredentials, applyProxy });
      added++;
    }
    if (added > 0) {
      const n = Math.max(1, this.network.connectConcurrency || 1);
      this.log(null, `fila de conexão: ${added} conta(s) entraram; ${n} por vez, a próxima entra quando uma autenticar ou falhar.`);
      this.pumpQueue();
    }
    return added;
  }

  /** Esvazia a fila (quem já está fazendo login continua). */
  clearQueue(): void {
    if (this.queue.length === 0) return;
    this.log(null, `fila de conexão cancelada (${this.queue.length} conta(s) não entraram).`);
    this.queue = [];
    this.bump();
  }

  private pumpQueue(): void {
    if (this.queuePumpTimer) {
      clearTimeout(this.queuePumpTimer);
      this.queuePumpTimer = null;
    }
    const limit = Math.max(1, this.network.connectConcurrency || 1);
    while (this.queueActive.size < limit && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (this.sessions.has(item.id)) continue;
      this.queueActive.add(item.id);
      this.queueTimers.set(item.id, setTimeout(() => this.queueRelease(item.id, 'tempo esgotado; a conta segue tentando sozinha'), QUEUE_SETTLE_MS));
      void this.connect(item.id, item.getCredentials, item.applyProxy);
    }
    this.bump();
  }

  /** Libera a vaga da conta na fila e, depois de um respiro, solta a próxima. */
  private queueRelease(id: string, why: string): void {
    const timer = this.queueTimers.get(id);
    if (timer) clearTimeout(timer);
    this.queueTimers.delete(id);
    if (!this.queueActive.delete(id)) return;
    const s = this.sessions.get(id);
    if (this.queue.length > 0) this.log(s ?? null, `fila: ${why}; próxima conta em ${QUEUE_GAP_MS / 1000} s (${this.queue.length} aguardando).`);
    if (this.queue.length > 0) {
      if (this.queuePumpTimer) clearTimeout(this.queuePumpTimer);
      this.queuePumpTimer = setTimeout(() => this.pumpQueue(), QUEUE_GAP_MS);
    }
    this.bump();
  }

  disconnect(id: string): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.queueRelease(id, 'desconectada');
    const s = this.sessions.get(id);
    if (!s) return;
    s.detach?.();
    if (s.captchaTimer) clearInterval(s.captchaTimer);
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.transport === 'headless') void this.headlessBridge?.disconnect(id);
    this.releaseClaims(id);
    this.sessions.delete(id);
    this.log(s, 'desconectada.');
    this.bump();
  }

  setPaused(id: string, paused: boolean): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.paused = paused;
    this.bump();
  }

  /** Chamado pela UI com o elemento <webview> recém-montado da sessão. */
  attachWebview(id: string, el: CrowdWebview | null): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.detach) { s.detach(); s.detach = null; }
    s.webview = el;
    if (!el) return;

    const onMessage = (ev: Event) => {
      const e = ev as Event & { channel: string; args: unknown[] };
      if (e.channel === WEBVIEW_CF_CHANNEL) {
        const params = e.args?.[0] as TurnstileRenderParams | undefined;
        if (params && params.sitekey) {
          s.cfParams = params;
          if (params.challenge) void this.solveChallenge(s);
        }
        return;
      }
      if (e.channel !== WEBVIEW_PROTO_CHANNEL) return;
      const msg = e.args?.[0] as AgentMessage | undefined;
      if (!msg || msg.__hab !== true) return;
      if (msg.type === 'ready') {
        s.agentReady = true;
        s.lastProgressAt = Date.now(); // a página avançou (nova navegação): não é travamento
        // Modo sem tela: o agente devolve um socket falso ao Nitro e nos entrega o handshake.
        // (Idempotente; também desarma se o usuário voltou ao modo webview.)
        this.sendAgentCommand(s, { type: 'intercept', enabled: this.network.mode === 'headless' });
        if (msg.payload.href.includes('/hotel')) this.log(s, `página do jogo carregou (interceptação ${msg.payload.intercepting ? 'ativa desde o início' : 'sendo armada agora'}); aguardando o cliente Nitro iniciar…`);
        this.bump();
      } else if (msg.type === 'packets') {
        for (const p of msg.payload) this.onPacket(s, p);
      } else if (msg.type === 'handshake') {
        void this.startHeadless(s, msg.payload);
      } else if (msg.type === 'socket' && msg.payload.event === 'intercepted') {
        s.lastProgressAt = Date.now();
        this.log(s, 'cliente Nitro interceptado (socket falso); aguardando o handshake com o ticket…');
      } else if (msg.type === 'socket' && msg.payload.event === 'open' && this.network.mode === 'headless' && s.transport === 'webview') {
        // O Nitro conectou de verdade antes de a interceptação valer: recarrega com a chave já gravada.
        if (s.interceptReloads < MAX_INTERCEPT_RELOADS) {
          s.interceptReloads++;
          this.log(s, 'o cliente conectou antes da interceptação; recarregando a página do jogo para capturar o ticket.');
          this.sendAgentCommand(s, { type: 'intercept', enabled: true });
          setTimeout(() => { if (s.webview === el) el.reload?.(); }, 200);
        } else {
          this.log(s, 'não consegui interceptar o cliente; esta conta segue no modo com tela.');
        }
      }
    };
    const onNavigate = () => { s.agentReady = false; s.cfParams = null; s.cfSolving = false; };
    const onStop = (ev: Event) => {
      if ((ev as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
      void this.afterLoad(s);
    };
    const onFail = (ev: Event) => {
      const e = ev as Event & { errorCode?: number; isMainFrame?: boolean; errorDescription?: string };
      if (e.isMainFrame !== true || e.errorCode === -3) return;
      // Rede lenta / proxy engasgado: não desiste; tenta de novo algumas vezes antes de marcar erro.
      if (s.stalls < MAX_STALLS) {
        s.stalls++;
        this.setStatus(s, 'loading', `falha ao carregar (${e.errorDescription ?? e.errorCode}); tentando de novo em ${RETRY_LOAD_MS / 1000} s (${s.stalls}/${MAX_STALLS})`);
        setTimeout(() => {
          if (this.sessions.get(s.id) === s && s.webview === el) this.navigate(el, HABBLET_HOME_URL);
        }, RETRY_LOAD_MS);
        return;
      }
      this.setStatus(s, 'error', `falha ao carregar (${e.errorDescription ?? e.errorCode}) após ${MAX_STALLS} tentativas`);
    };
    el.addEventListener('ipc-message', onMessage);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail);
    s.detach = () => {
      el.removeEventListener('ipc-message', onMessage);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail);
    };
  }

  private onPacket(s: Session, p: ProtocolPacket): void {
    s.state.handle(p);
    if (s.status !== 'online' && s.state.snapshot().me) {
      this.setStatus(s, 'online', `logado como ${s.state.snapshot().me!.name}${s.transport === 'headless' ? ' (sem tela)' : ''}`);
    }
    // Perseguição em tempo real: reage ao movimento no instante em que o 1640 chega, sem esperar o relógio.
    if (s.follow && s.status === 'online' && !s.paused && FOLLOW_TRIGGERS.has(p.header)) {
      if (this.tickFollow(s, Date.now())) this.bump();
    }
    if (s.posture && s.status === 'online' && !s.paused && POSTURE_TRIGGERS.has(p.header)) {
      if (this.tickPosture(s, Date.now())) this.bump();
    }
    // Perfil pedido para copiar o visual: aplica o visual que veio no 3898.
    if (p.header === H.USER_PROFILE && p.dir === 'in' && s.lookPending.size > 0) {
      const snap = s.state.snapshot();
      const ev = snap.events.length > 0 ? snap.events[snap.events.length - 1] : undefined;
      if (ev && ev.kind === 'profile') {
        const key = ev.name.toLowerCase();
        const askedAt = s.lookPending.get(key);
        if (askedAt !== undefined && Date.now() - askedAt < 20_000) {
          s.lookPending.delete(key);
          if (ev.figure) {
            // Gênero: o perfil não traz; usa o da pessoa se ela estiver na sala, senão o da própria conta.
            const inRoom = snap.room.users.find((x) => x.id === ev.userId);
            const gender = inRoom?.sex || snap.me?.gender || 'M';
            s.actions.setFigure(gender, ev.figure);
            this.log(s, `visual copiado de ${ev.name} (${ev.online ? 'online' : 'offline'}): ${ev.figure}`);
          } else {
            this.log(s, `o perfil de ${ev.name} veio sem visual.`);
          }
        }
      }
    }
    if (p.header === H.USER_FIGURE && p.dir === 'in') {
      const snap = s.state.snapshot();
      const ev = snap.events.length > 0 ? snap.events[snap.events.length - 1] : undefined;
      if (ev && ev.kind === 'figure') this.log(s, `✔ servidor aceitou o visual novo (${ev.gender}).`);
    }
    if (p.header === H.GROUP_JOIN_FAILED && p.dir === 'in') {
      const snap = s.state.snapshot();
      const ev = snap.events.length > 0 ? snap.events[snap.events.length - 1] : undefined;
      if (ev && ev.kind === 'group-join-failed') this.log(s, `✖ entrada no grupo recusada (motivo ${ev.reason}).`);
    }
    // Confirmação de respeito que esta conta mandou (o 2815 chega para todos na sala; só logamos os nossos).
    if (p.header === H.RESPECT_RECEIVED && p.dir === 'in' && s.respectPending.size > 0) {
      const snap = s.state.snapshot();
      const ev = snap.events.length > 0 ? snap.events[snap.events.length - 1] : undefined;
      if (ev && ev.kind === 'respect') {
        const sentAt = s.respectPending.get(ev.userId);
        if (sentAt !== undefined && Date.now() - sentAt < 15_000) {
          s.respectPending.delete(ev.userId);
          this.log(s, `✔ respeitou ${ev.name ?? '#' + ev.userId} (${ev.respects} respeito(s) no total).`);
        }
      }
    }
  }

  /** Roda o motor de Seguir da sessão; devolve true se o status mudou (interface precisa atualizar). */
  private tickFollow(s: Session, now: number): boolean {
    const before = s.engines.follow.status;
    s.engines.follow.tick({
      now,
      agentReady: s.agentReady,
      snapshot: s.state.snapshot(),
      state: s.state,
      actions: s.actions,
      enabled: !!s.follow,
      config: s.follow ?? { target: '', mode: 'pin' },
      log: (m) => this.log(s, '[Seguir] ' + m),
    });
    if (s.follow?.mode === 'once' && s.engines.follow.finished) s.follow = null;
    return s.engines.follow.status !== before;
  }

  /** Roda o motor de postura (sentar/deitar) da sessão; devolve true se o status mudou. */
  private tickPosture(s: Session, now: number): boolean {
    const before = s.engines.posture.status;
    const snapshot = s.state.snapshot();
    const roomId = snapshot.room.id;
    s.engines.posture.tick({
      now,
      agentReady: s.agentReady,
      snapshot,
      actions: s.actions,
      enabled: !!s.posture,
      config: s.posture ?? { posture: 'sit' },
      env: {
        catalog: this.furniCatalog,
        claim: (key) => (roomId === null ? true : this.claimTile(roomId, key, s.id)),
        release: (key) => {
          if (roomId !== null) this.releaseTile(roomId, key, s.id);
        },
      },
      log: (m) => this.log(s, '[Sentar] ' + m),
    });
    if (s.posture && s.engines.posture.finished) {
      s.posture = null;
      this.releaseClaims(s.id);
    }
    return s.engines.posture.status !== before;
  }

  private claimTile(roomId: number, key: string, sessionId: string): boolean {
    let m = this.postureClaims.get(roomId);
    if (!m) {
      m = new Map();
      this.postureClaims.set(roomId, m);
    }
    const owner = m.get(key);
    if (owner !== undefined && owner !== sessionId) return false;
    m.set(key, sessionId);
    return true;
  }

  private releaseTile(roomId: number, key: string, sessionId: string): void {
    const m = this.postureClaims.get(roomId);
    if (m && m.get(key) === sessionId) m.delete(key);
  }

  private releaseClaims(sessionId: string): void {
    for (const m of this.postureClaims.values()) for (const [k, owner] of m) if (owner === sessionId) m.delete(k);
  }

  private sendAgentCommand(s: Session, cmd: AgentCommand): void {
    try {
      s.webview?.send?.(WEBVIEW_CMD_CHANNEL, cmd);
    } catch {
      /* webview desmontado */
    }
  }

  /**
   * Grava a chave de interceptação no sessionStorage da página do site (mesma origem do /hotel), para
   * o agente já nascer interceptando quando o jogo carregar — antes mesmo de receber o comando.
   */
  private async armPageIntercept(w: CrowdWebview): Promise<void> {
    try {
      await w.executeJavaScript(`try{sessionStorage.setItem(${JSON.stringify(INTERCEPT_STORAGE_KEY)},'1')}catch(e){}`);
    } catch {
      /* página em transição */
    }
  }

  /* ------------------------------------ modo sem tela ------------------------------------ */

  /** O agente capturou o handshake do Nitro (versão, machine id, ticket): sobe o cliente em Node pelo proxy da conta. */
  private async startHeadless(s: Session, hs: InterceptedHandshake): Promise<void> {
    if (this.network.mode !== 'headless') return; // o modo mudou no meio do caminho
    if (s.transport === 'headless') return; // já conectando
    if (!this.headlessBridge) {
      this.setStatus(s, 'error', 'modo sem tela indisponível (fora do Electron)');
      return;
    }
    s.transport = 'headless';
    this.setStatus(s, 'loading', `ticket capturado (${hs.packets.length} pacotes); conectando ao jogo sem tela${s.proxyRules ? ' pelo proxy' : ''}…`);
    try {
      await this.headlessBridge.connect(s.id, hs);
    } catch (e) {
      s.transport = 'webview';
      this.setStatus(s, 'error', 'cliente sem tela: ' + cleanErr(e));
    }
  }

  /** Eventos do cliente sem tela (main → renderer), ligados pelo controlador. */
  onHeadlessEvent(ev: HeadlessEvent): void {
    const s = this.sessions.get(ev.id);
    if (!s) return;
    switch (ev.kind) {
      case 'open':
        s.agentReady = true;
        this.log(s, 'WebSocket do jogo aberto sem tela; handshake enviado.');
        this.bump();
        break;
      case 'packets':
        for (const p of ev.packets) this.onPacket(s, p);
        if (!s.headlessActive && s.status === 'online') this.dropWebview(s);
        break;
      case 'stats':
        s.headlessBytes = { in: ev.bytesIn, out: ev.bytesOut };
        this.bump();
        break;
      case 'error':
        this.log(s, 'cliente sem tela: ' + ev.message);
        break;
      case 'close': {
        if (ev.byUser) return;
        s.agentReady = false;
        this.setStatus(s, 'error', `conexão do jogo caiu (código ${ev.code}${ev.reason ? ', ' + ev.reason : ''})`);
        if (this.network.autoReconnect && s.reconnect) {
          this.log(s, `reconectando em ${RECONNECT_DELAY_MS / 1000} s (novo login).`);
          if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
          s.reconnectTimer = setTimeout(() => {
            if (this.sessions.get(s.id) === s) s.reconnect?.();
          }, RECONNECT_DELAY_MS);
        }
        break;
      }
    }
  }

  /** Autenticado sem tela: a página do jogo (com o socket falso) não serve para mais nada. */
  private dropWebview(s: Session): void {
    s.headlessActive = true;
    s.detach?.();
    s.detach = null;
    s.webview = null;
    if (s.captchaTimer) {
      clearInterval(s.captchaTimer);
      s.captchaTimer = null;
    }
    this.log(s, 'logada sem tela: página do jogo descartada, só protocolo daqui em diante.');
    this.bump();
  }

  /**
   * Espera a página "assentar": em conexões lentas o `did-stop-loading` dispara antes do formulário
   * de login existir (render tardio, scripts ainda baixando). Sonda a cada 400 ms até ver o
   * formulário com os dois campos, o desafio do Cloudflare ou o /hotel, por até 30 s. Devolve a
   * última sondagem (ou null se a página/sessão mudou no meio).
   */
  private async waitForPage(s: Session, w: CrowdWebview): Promise<LoginProbe | null> {
    const started = Date.now();
    let last: LoginProbe | null = null;
    while (Date.now() - started < PAGE_SETTLE_MS) {
      if (this.sessions.get(s.id) !== s || s.webview !== w) return null;
      if (safeUrl(w).includes('/hotel')) return null; // o afterLoad do /hotel assume
      try {
        last = (await w.executeJavaScript(PROBE_LOGIN_JS)) as LoginProbe;
      } catch {
        last = null; // página em transição
      }
      if (last && (last.cfChallenge || (last.hasForm && last.hasInputs))) return last;
      if (last && last.readyState === 'complete' && !last.hasForm && (last.hasLogout || Date.now() - started > 6000)) {
        // Página pronta e sem formulário: com link de sair, já autenticada; sem ele, esperamos um pouco
        // (o formulário pode chegar por script) e depois deixamos o hotel decidir.
        return last;
      }
      await new Promise((r) => setTimeout(r, PAGE_POLL_MS));
    }
    return last;
  }

  /** Fluxo de login: decide o que fazer conforme a página que acabou de carregar. */
  private async afterLoad(s: Session): Promise<void> {
    const w = s.webview;
    if (!w) return;
    const url = safeUrl(w);
    if (url.includes('/hotel')) {
      if (s.status !== 'online') {
        this.setStatus(s, 'hotel', this.network.mode === 'headless' ? 'no hotel: interceptando o cliente para conectar sem tela' : 'no hotel, aguardando o cliente conectar');
      }
      return;
    }
    if (!url.includes('habblet.city')) return;
    if (s.probing || s.loginInFlight) return; // já tem uma sondagem/login cuidando desta página
    s.probing = true;
    let probe: LoginProbe | null;
    try {
      if (s.status === 'loading' && s.detail === 'abrindo o site') this.setStatus(s, 'loading', 'site carregando; aguardando o formulário de login');
      probe = await this.waitForPage(s, w);
    } finally {
      s.probing = false;
    }
    if (!probe) return;
    if (probe.hasForm && !probe.hasInputs) {
      this.log(s, `formulário presente mas sem os campos após ${PAGE_SETTLE_MS / 1000} s; o vigia vai recarregar.`);
      return;
    }
    if (probe.cfChallenge) {
      if (s.cfSolving) return; // o resolvedor já está cuidando
      if (this.solver && s.cfParams?.challenge) { void this.solveChallenge(s); return; }
      this.setStatus(s, 'captcha', this.solver
        ? 'desafio do Cloudflare: aguardando o widget para resolver automaticamente…'
        : 'desafio do Cloudflare: clique em "Confirme que é humano" na tela da conta');
      return;
    }
    if (probe.hasForm) {
      if (s.loginInFlight) return;
      if (s.status === 'captcha') return; // o vigia do captcha cuida do envio
      if (s.loginAttempts > 0 && Date.now() - s.lastLoginAt < 15000 && probe.errorText) {
        // Voltou ao formulário logo após enviar, com mensagem de erro do site: credenciais recusadas.
        this.setStatus(s, 'error', `login recusado: ${probe.errorText}`);
        return;
      }
      if (s.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        this.setStatus(s, 'error', `login não passou após ${MAX_LOGIN_ATTEMPTS} tentativas (confira usuário e senha)`);
        return;
      }
      if (!s.credentials) { this.setStatus(s, 'error', 'sem credenciais'); return; }
      s.loginInFlight = true;
      s.loginAttempts++;
      s.lastLoginAt = Date.now();
      this.setStatus(s, 'logging-in', `preenchendo login (${s.loginAttempts}/${MAX_LOGIN_ATTEMPTS})`);
      // Se o site nos levar direto ao /hotel após o login, o agente de lá já nasce interceptando.
      if (this.network.mode === 'headless') await this.armPageIntercept(w);
      try {
        const r = (await w.executeJavaScript(buildLoginJs(s.credentials.username, s.credentials.password))) as LoginAttemptResult;
        if (r.ok) this.log(s, 'usuário e senha preenchidos e conferidos; formulário enviado, aguardando o site.');
        else if (r.step === 'turnstile-timeout') {
          // 1) resolvedor automático, se configurado; 2) senão, vigia manual
          if (!(await this.trySolver(s))) this.startCaptchaWatch(s);
        } else if (r.step === 'no-form' || r.step === 'fields-timeout' || r.step === 'fill-failed') {
          // Página lenta ou re-renderizada no meio: não conta como tentativa; o vigia recarrega se não avançar.
          s.loginAttempts = Math.max(0, s.loginAttempts - 1);
          this.setStatus(s, 'loading', `${r.message ?? r.step}; tentando de novo`);
          setTimeout(() => { if (this.sessions.get(s.id) === s && s.webview === w) void this.afterLoad(s); }, 1500);
        } else this.setStatus(s, 'error', r.message ?? r.step);
      } catch (e) {
        // executeJavaScript cai quando a página navega no meio (o submit funcionou): o did-stop-loading seguinte assume.
        this.log(s, 'página mudou durante o preenchimento: ' + cleanErr(e));
      } finally {
        s.loginInFlight = false;
      }
      return;
    }
    // Sem formulário e fora do hotel: sessão web autenticada → vai para o jogo. Se o site nos devolver ao
    // formulário, é porque não estava (bounce): o próximo afterLoad preenche; depois de alguns bounces, para.
    if (s.hotelBounces >= MAX_HOTEL_BOUNCES) {
      this.setStatus(s, 'error', 'o site não mostra o formulário de login nem entra no hotel');
      return;
    }
    s.hotelBounces++;
    if (!probe.hasLogout) this.log(s, `página ${new URL(probe.url).pathname} sem formulário nem link de sair: tentando o hotel para ver se a sessão já está autenticada (${s.hotelBounces}/${MAX_HOTEL_BOUNCES}).`);
    // "Proxy depois do login" no modo com tela: a sessão fez o login direta; agora, antes do hotel, o
    // WebSocket do jogo passa a sair pelo proxy. (Sem tela não precisa: o cliente Node já usa o proxy.)
    if (s.proxyDeferred && this.network.mode === 'webview' && s.applyProxy) {
      try {
        const r = await s.applyProxy(s.id, 'game');
        this.log(s, `autenticado: proxy ${r.rules ?? 'direto'} aplicado à conexão do jogo antes de abrir o hotel.`);
        if (r.warning) this.log(s, `⚠ ${r.warning}`);
      } catch (e) {
        this.setStatus(s, 'error', 'proxy do jogo: ' + cleanErr(e));
        return;
      }
    }
    // Já como 'hotel': o carregamento do cliente Nitro é lento e tem folga própria no vigia.
    this.setStatus(s, 'hotel', 'autenticado no site, abrindo o hotel (o cliente do jogo pode levar até alguns minutos para carregar)');
    if (this.network.mode === 'headless') await this.armPageIntercept(w);
    this.navigate(w, HABBLET_HOTEL_URL);
  }

  /**
   * Vigia do login: se uma sessão fica em loading / logging-in / hotel sem nenhuma mudança por 60 s
   * (página que nunca terminou, formulário que não veio, Nitro que não conectou), recomeça pela
   * página inicial. Depois de 3 reinícios, marca erro em vez de rodar para sempre.
   */
  private watchStalls(now: number): void {
    for (const s of this.sessions.values()) {
      if (s.status !== 'loading' && s.status !== 'logging-in' && s.status !== 'hotel') continue;
      if (now - s.lastProgressAt < (s.status === 'hotel' ? HOTEL_STALL_MS : STALL_MS)) continue;
      const w = s.webview;
      if (!w) { s.lastProgressAt = now; continue; }
      if (s.stalls >= MAX_STALLS) {
        this.setStatus(s, 'error', `login não avançou após ${MAX_STALLS} reinícios (último estado: ${s.detail})`);
        continue;
      }
      s.stalls++;
      s.loginInFlight = false;
      s.probing = false;
      const wasHotel = s.status === 'hotel';
      const waited = Math.round((now - s.lastProgressAt) / 1000);
      this.setStatus(s, wasHotel ? 'hotel' : 'loading', `sem progresso há ${waited} s (${s.detail}); ${wasHotel ? 'recarregando o hotel' : 'recomeçando pela página inicial'} (${s.stalls}/${MAX_STALLS})`);
      if (wasHotel) {
        if (this.network.mode === 'headless') this.sendAgentCommand(s, { type: 'intercept', enabled: true });
        if (w.reload) w.reload();
        else this.navigate(w, HABBLET_HOTEL_URL);
      } else {
        this.navigate(w, HABBLET_HOME_URL);
      }
    }
  }

  /**
   * Página de desafio do Cloudflare (interstitial antes do site). Com o resolvedor configurado
   * (2Captcha, modo "challenge page"), pede o token com os parâmetros capturados pelo hook e
   * entrega ao callback do widget; a página então libera e navega para o site sozinha.
   */
  private async solveChallenge(s: Session): Promise<void> {
    const w = s.webview;
    const params = s.cfParams;
    if (!this.solver || !w || !params || s.cfSolving) {
      if (!this.solver && s.status !== 'captcha') this.setStatus(s, 'captcha', 'desafio do Cloudflare: clique em "Confirme que é humano" na tela da conta');
      return;
    }
    s.cfSolving = true;
    this.setStatus(s, 'captcha', 'desafio do Cloudflare: resolvendo pelo serviço configurado…');
    const started = Date.now();
    const r = await this.solver({ url: params.url, sitekey: params.sitekey, action: params.action, cdata: params.cdata, pagedata: params.pagedata, userAgent: params.userAgent });
    if (!this.sessions.has(s.id) || s.webview !== w || s.cfParams !== params) return; // navegou / desconectou
    s.cfSolving = false;
    if (!r.ok) {
      this.setStatus(s, 'captcha', `resolvedor falhou (${r.error}); clique em "Confirme que é humano" na tela`);
      return;
    }
    try {
      const delivered = (await w.executeJavaScript(`typeof window.__habCfSolve === 'function' && window.__habCfSolve(${JSON.stringify(r.token)})`)) as boolean;
      if (delivered) this.setStatus(s, 'loading', `desafio resolvido em ${Math.round((Date.now() - started) / 1000)} s; entrando no site`);
      else this.setStatus(s, 'captcha', 'token resolvido, mas o widget não aceitou callback; resolva na tela');
    } catch (e) {
      this.setStatus(s, 'captcha', 'erro ao entregar o token: ' + cleanErr(e));
    }
  }

  /** Pede o token do Turnstile ao resolvedor configurado, injeta e envia. true = login enviado. */
  private async trySolver(s: Session): Promise<boolean> {
    const w = s.webview;
    if (!this.solver || !w) return false;
    // Preferimos os parâmetros capturados pelo hook (render explícito); senão lemos o DOM.
    let req: TurnstileSolveRequest | null = null;
    if (s.cfParams && !s.cfParams.challenge) {
      const c = s.cfParams;
      req = { url: c.url, sitekey: c.sitekey, action: c.action, cdata: c.cdata };
    } else {
      let info: TurnstileInfo;
      try {
        info = (await w.executeJavaScript(PROBE_TURNSTILE_JS)) as TurnstileInfo;
      } catch {
        return false;
      }
      if (info.hasForm && info.sitekey) req = { url: info.url, sitekey: info.sitekey, action: info.action ?? undefined, cdata: info.cdata ?? undefined };
    }
    if (!req) {
      this.log(s, 'resolvedor: sitekey do Turnstile não encontrada na página; caindo para o modo manual.');
      return false;
    }
    this.setStatus(s, 'captcha', 'resolvendo o Turnstile do login pelo serviço configurado…');
    const started = Date.now();
    const r = await this.solver(req);
    if (!this.sessions.has(s.id) || s.webview !== w) return true; // desconectada no meio
    if (!r.ok) {
      this.log(s, `resolvedor falhou (${r.error}); caindo para o modo manual.`);
      return false;
    }
    try {
      const sub = (await w.executeJavaScript(buildSubmitWithTokenJs(r.token))) as LoginAttemptResult;
      if (!sub.ok) { this.log(s, 'resolvedor: formulário sumiu antes do envio.'); return false; }
      s.lastLoginAt = Date.now();
      this.setStatus(s, 'logging-in', `captcha resolvido em ${Math.round((Date.now() - started) / 1000)} s; login enviado`);
      return true;
    } catch (e) {
      this.log(s, 'resolvedor: erro ao injetar o token: ' + cleanErr(e));
      return false;
    }
  }

  /**
   * Turnstile exigiu interação: a conta fica em "captcha" com a tela visível para o usuário
   * clicar no desafio; a cada 2 s verificamos se o token apareceu e, se sim, enviamos o login.
   */
  private startCaptchaWatch(s: Session): void {
    this.setStatus(s, 'captcha', 'Turnstile pede interação: clique no desafio na tela da conta');
    s.loginAttempts = Math.max(0, s.loginAttempts - 1); // não conta como tentativa falha
    if (s.captchaTimer) clearInterval(s.captchaTimer);
    const started = Date.now();
    s.captchaTimer = setInterval(async () => {
      const w = s.webview;
      if (!w || !this.sessions.has(s.id) || s.status !== 'captcha') { if (s.captchaTimer) clearInterval(s.captchaTimer); s.captchaTimer = null; return; }
      if (Date.now() - started > 5 * 60 * 1000) {
        clearInterval(s.captchaTimer!); s.captchaTimer = null;
        this.setStatus(s, 'error', 'captcha não resolvido em 5 min');
        return;
      }
      try {
        const r = (await w.executeJavaScript(RESUME_LOGIN_JS)) as { form: boolean; sent: boolean; hasUser?: boolean };
        if (!r.form) { clearInterval(s.captchaTimer!); s.captchaTimer = null; return; } // navegou: afterLoad assume
        if (r.hasUser === false && s.credentials) {
          // página recarregou e limpou os campos: preenche de novo (sem esperar o token aqui)
          // Só repreenche (espera zero pelo Turnstile: quem envia é este vigia, quando o token aparecer).
          await w.executeJavaScript(buildLoginJs(s.credentials.username, s.credentials.password, undefined, 0));
        }
        if (r.sent) {
          clearInterval(s.captchaTimer!); s.captchaTimer = null;
          s.lastLoginAt = Date.now();
          s.loginAttempts++;
          this.setStatus(s, 'logging-in', 'captcha resolvido; login enviado');
        }
      } catch { /* página em transição */ }
    }, 2000);
  }

  private navigate(w: CrowdWebview, url: string): void {
    if (w.loadURL) void w.loadURL(url).catch(() => {});
    else w.src = url;
  }

  private sendPacket(id: string, header: number, body: Uint8Array): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.transport === 'headless') {
      this.headlessBridge?.send(id, header, bytesToBase64(body));
      return;
    }
    if (!s.webview?.send) return;
    try {
      s.webview.send(WEBVIEW_CMD_CHANNEL, { type: 'send', header, bodyBase64: bytesToBase64(body) });
    } catch {
      /* webview desmontado */
    }
  }

  /* ------------------------------------ relógio ------------------------------------ */

  private tick(): void {
    const now = Date.now();
    this.watchStalls(now);
    if (!this.configs) return;
    let statsChanged = false;
    for (const s of this.sessions.values()) {
      if (s.status !== 'online' || s.paused) continue;
      const snapshot = s.state.snapshot();
      const base = { now, agentReady: s.agentReady, snapshot, state: s.state, actions: s.actions };
      const mk = (id: AddonId) => (m: string) => this.log(s, ADDON_BY_ID[id].logPrefix + m);
      const before = s.engines.adduserall.statsVersion;
      s.engines.adduserall.tick({ ...base, enabled: this.addonsEnabled.adduserall, config: this.configs.adduserall, log: mk('adduserall') });
      s.engines.automessage.tick({ ...base, enabled: this.addonsEnabled.automessage, config: this.configs.automessage, log: mk('automessage') });
      s.engines.autoreplywhispers.tick({ ...base, enabled: this.addonsEnabled.autoreplywhispers, config: this.configs.autoreplywhispers, log: mk('autoreplywhispers') });
      s.engines.consoletracker.tick({ ...base, enabled: this.addonsEnabled.consoletracker, config: this.configs.consoletracker, log: mk('consoletracker') });
      s.engines.autoaccept.tick({ ...base, enabled: this.addonsEnabled.autoaccept, config: this.configs.autoaccept, log: mk('autoaccept') });
      s.engines.nudgeeveryone.tick({ ...base, enabled: this.addonsEnabled.nudgeeveryone, config: this.configs.nudgeeveryone, log: mk('nudgeeveryone') });
      // Perseguição (fixar / ir até): comando por sessão, não addon. Também roda a cada 1640 (onPacket).
      if (this.tickFollow(s, now)) statsChanged = true;
      if (this.tickPosture(s, now)) statsChanged = true;
      if (s.engines.adduserall.statsVersion !== before) statsChanged = true;
    }
    // Estado do jogo muda o tempo todo (sala, usuários); publica no máximo 4x/s.
    if (statsChanged || this.sessions.size > 0) this.bump();
  }

  /* ------------------------------------ comandos ------------------------------------ */

  /** Sessões prontas para agir: online, não pausadas, com agente/socket. `ids` null = todas. */
  private active(ids: string[] | null = null): Session[] {
    return [...this.sessions.values()].filter((s) => s.status === 'online' && !s.paused && s.agentReady && (!ids || ids.includes(s.id)));
  }

  /**
   * Executa um comando do dashboard nas contas alvo (`ids` null = todas as ativas). Devolve em quantas
   * agiu e uma frase para o toast. Comandos por nick resolvem o alvo no estado de cada conta.
   */
  execute(ids: string[] | null, cmd: CrowdCommand): CommandResult {
    const list = this.active(ids);
    const who = ids && ids.length > 0 ? `${list.length} conta(s) selecionada(s)` : `${list.length} conta(s)`;
    let done = 0;
    const each = (fn: (s: Session, snap: GameSnapshot) => boolean | void) => {
      for (const s of list) if (fn(s, s.state.snapshot()) !== false) done++;
    };
    let text: string;
    switch (cmd.kind) {
      case 'enterRoom':
        each((s) => { s.actions.visitRoom(cmd.roomId); });
        text = `${who} entrando no quarto #${cmd.roomId}`;
        break;
      case 'followFriend':
        each((s, snap) => {
          const f = snap.friends.find((x) => x.name.toLowerCase() === cmd.name.trim().toLowerCase());
          if (f) s.actions.followFriend(f.id);
          else s.actions.chat(`:follow ${cmd.name.trim()}`);
        });
        text = `${who} seguindo ${cmd.name} até o quarto dele`;
        break;
      case 'chat':
        each((s) => { s.actions.chat(cmd.text); });
        text = `${who} falaram "${cmd.text.slice(0, 40)}"`;
        break;
      case 'shout':
        each((s) => { s.actions.shout(cmd.text); });
        text = `${who} gritaram "${cmd.text.slice(0, 40)}" (2085, a confirmar)`;
        break;
      case 'whisper':
        each((s) => { s.actions.whisper(cmd.nick, cmd.text); });
        text = `${who} sussurraram para ${cmd.nick}`;
        break;
      case 'walk':
        each((s) => { s.actions.walkTo(cmd.x, cmd.y); });
        text = `${who} andando até (${cmd.x}, ${cmd.y})`;
        break;
      case 'look':
        each((s) => { s.actions.lookTo(cmd.x, cmd.y); });
        text = `${who} olhando para (${cmd.x}, ${cmd.y})`;
        break;
      case 'goTo':
        each((s) => { s.follow = { target: cmd.name.trim(), mode: 'once' }; });
        text = `${who} indo até ${cmd.name}`;
        break;
      case 'pin':
        each((s) => { s.follow = { target: cmd.name.trim(), mode: 'pin' }; });
        text = `${who} fixada(s) em ${cmd.name}: perseguindo em tempo real`;
        break;
      case 'unpin':
        each((s) => { if (!s.follow) return false; s.follow = null; });
        text = `${done} conta(s) soltaram o alvo`;
        break;
      case 'requestFriend':
        each((s) => { s.actions.requestFriend(cmd.name); });
        text = `${who} pediram amizade a ${cmd.name}`;
        break;
      case 'acceptPending': {
        let total = 0;
        each((s, snap) => {
          const reqIds = snap.pendingRequests.map((r) => r.requestId);
          if (reqIds.length === 0) return false;
          s.actions.acceptFriends(reqIds);
          total += reqIds.length;
        });
        text = `${total} pedido(s) aceito(s) em ${done} conta(s)`;
        break;
      }
      case 'clickUser':
        each((s, snap) => {
          const u = snap.room.users.find((x) => x.type === 1 && x.name.toLowerCase() === cmd.name.trim().toLowerCase());
          if (!u) return false;
          s.actions.clickUser(u);
        });
        text = `${done} conta(s) clicaram em ${cmd.name}`;
        break;
      case 'respect':
        each((s, snap) => {
          const u = snap.room.users.find((x) => x.type === 1 && x.name.toLowerCase() === cmd.name.trim().toLowerCase());
          if (!u) return false;
          s.actions.respect(u.id);
          s.respectPending.set(u.id, Date.now());
        });
        text = `${done} conta(s) respeitaram ${cmd.name}`;
        break;
      case 'joinGroup':
        each((s) => { s.actions.joinGroup(cmd.groupId); });
        text = `${who} pediram para entrar no grupo #${cmd.groupId}`;
        break;
      case 'rateRoom':
        each((s, snap) => {
          if (snap.room.id === null) return false;
          s.actions.rateRoom();
        });
        text = `${done} conta(s) deram nota ao quarto`;
        break;
      case 'inviteFriends': {
        let invited = 0;
        each((s, snap) => {
          if (snap.room.id === null) return false;
          const ids = snap.friends.filter((f) => !cmd.onlineOnly || f.online).map((f) => f.id);
          if (ids.length === 0) return false;
          invited += s.actions.inviteToRoom(ids, cmd.message);
          this.log(s, `convidou ${ids.length} amigo(s)${cmd.onlineOnly ? ' online' : ''} para o quarto ${cleanRoomName(snap.room.name) || '#' + snap.room.id}.`);
        });
        text = `${done} conta(s) enviaram ${invited} convite(s) para o quarto`;
        break;
      }
      case 'setLook':
        each((s, snap) => {
          s.actions.setFigure(cmd.gender ?? snap.me?.gender ?? 'M', cmd.figure);
        });
        text = `${done} conta(s) trocaram o visual`;
        break;
      case 'copyLook': {
        const key = cmd.name.trim().toLowerCase();
        each((s) => {
          s.lookPending.set(key, Date.now());
          s.actions.requestProfile(cmd.name.trim());
        });
        text = `${done} conta(s) pedindo o perfil de ${cmd.name} para copiar o visual`;
        break;
      }
      case 'posture':
        each((s, snap) => {
          if (snap.room.id === null) return false;
          s.posture = { posture: cmd.posture };
        });
        text = `${done} conta(s) procurando onde ${cmd.posture === 'sit' ? 'sentar' : 'deitar'}${this.furniCatalog ? '' : ' (sem furnidata: só casas onde já viram alguém sentado)'}`;
        break;
      case 'standUp':
        each((s, snap) => {
          s.posture = null;
          this.releaseClaims(s.id);
          const me = snap.me ? snap.room.users.find((u) => u.id === snap.me!.id) : undefined;
          if (!me || !me.posture) return false;
          // Uma casa vizinha livre que não seja outro mobi sentável/deitável (senão sentaria de novo).
          const spots = new Set<string>([...postureSpots(snap.room.floorItems, this.furniCatalog, 'sit').keys(), ...postureSpots(snap.room.floorItems, this.furniCatalog, 'lay').keys()]);
          const occupied = new Set<string>();
          for (const u of snap.room.users) {
            if (u.id === me.id) continue;
            occupied.add(tileKey(u));
            if (u.moveTarget) occupied.add(tileKey(u.moveTarget));
          }
          const around = approachTiles(me, null);
          const free = around.find((t) => !occupied.has(tileKey(t)) && !spots.has(tileKey(t))) ?? around.find((t) => !occupied.has(tileKey(t)));
          if (!free) return false;
          s.actions.walkTo(free.x, free.y);
        });
        text = `${done} conta(s) levantaram`;
        break;
      case 'cancelPosture':
        each((s) => {
          if (!s.posture) return false;
          s.posture = null;
          this.releaseClaims(s.id);
        });
        text = `${done} conta(s) pararam de procurar lugar`;
        break;
      case 'console':
        each((s, snap) => {
          const f = snap.friends.find((x) => x.name.toLowerCase() === cmd.name.trim().toLowerCase());
          if (!f) return false;
          s.actions.consoleMessage(f.id, cmd.text);
        });
        text = `${done} conta(s) mandaram console para ${cmd.name}${done < list.length ? ` (${list.length - done} não têm ${cmd.name} como amigo)` : ''}`;
        break;
    }
    this.log(null, text + '.');
    this.bump();
    return { count: done, text };
  }

  /** Ação arbitrária por sessão (para comandos futuros). */
  forEachActive(fn: (actions: GameActions, snapshot: GameSnapshot, account: CrowdAccount) => void, ids: string[] | null = null): number {
    const list = this.active(ids);
    for (const s of list) fn(s.actions, s.state.snapshot(), s.account);
    return list.length;
  }

  /* ------------------------------------ leitura ------------------------------------ */

  snapshot(): CrowdSnapshot {
    if (this.snapshotCache && this.snapshotCache.version === this.version) return this.snapshotCache;
    const sessions: CrowdSessionView[] = [];
    const commands = new Set<string>();
    for (const s of this.sessions.values()) {
      const snap = s.state.snapshot();
      for (const c of snap.commands) commands.add(c.command);
      const meUnit = snap.me ? snap.room.users.find((u) => u.id === snap.me!.id) : undefined;
      sessions.push({
        follow: s.follow,
        followStatus: s.follow ? s.engines.follow.status : '',
        pos: meUnit ? { x: meUnit.x, y: meUnit.y } : null,
        posture: meUnit?.posture ?? null,
        postureTask: s.posture?.posture ?? null,
        postureStatus: s.posture ? s.engines.posture.status : '',
        id: s.id,
        account: s.account,
        status: s.status,
        detail: s.detail,
        agentReady: s.agentReady,
        me: snap.me?.name ?? null,
        figure: snap.me?.figure ?? null,
        roomName: snap.room.name,
        roomId: snap.room.id,
        roomUsers: snap.room.users.filter((u) => u.type === 1).length,
        pendingRequests: snap.pendingRequests.length,
        sent: s.engines.adduserall.stats.done,
        paused: s.paused,
        proxyRules: s.proxyRules,
        exitIp: s.exitIp,
        transport: s.transport,
        bytesIn: s.headlessBytes.in,
        bytesOut: s.headlessBytes.out,
      });
    }
    this.snapshotCache = {
      version: this.version,
      sessions,
      // Contas que precisam de uma página do jogo montada: as sem tela já autenticadas ficam de fora.
      connectedIds: [...this.sessions.values()].filter((s) => s.ready && !s.headlessActive).map((s) => s.id),
      queuedIds: this.queue.map((q) => q.id),
      connectingIds: [...this.queueActive],
      addonsEnabled: this.addonsEnabled,
      logs: this.logs,
      commands: [...commands].sort(),
    };
    return this.snapshotCache;
  }

  sessionSnapshot(id: string): GameSnapshot | null {
    return this.sessions.get(id)?.state.snapshot() ?? null;
  }

  /* ------------------------------------ interno ------------------------------------ */

  private setStatus(s: Session, status: CrowdSessionStatus, detail: string): void {
    if (s.status === status && s.detail === detail) return;
    s.status = status;
    s.detail = detail;
    s.lastProgressAt = Date.now();
    if (status === 'online') s.stalls = 0;
    this.log(s, detail);
    // Fila de conexão: online, erro ou captcha (espera humana) liberam a vaga para a próxima conta.
    if (status === 'online' || status === 'error' || status === 'captcha') {
      this.queueRelease(s.id, status === 'online' ? 'autenticada' : status === 'captcha' ? 'caiu no captcha' : 'falhou');
    }
    try {
      this.statusListener?.(s.id, status, detail);
    } catch {
      /* o ouvinte não pode derrubar a sessão */
    }
    this.bump();
  }

  private log(s: Session | null, msg: string): void {
    const entry: CrowdLogEntry = { t: Date.now(), sessionId: s?.id ?? '', username: s?.account.username ?? 'multidão', msg };
    this.logs.push(entry);
    if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
    this.externalLog?.(`[${entry.username}] ${msg}`);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

function cleanErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function safeUrl(w: CrowdWebview): string {
  try {
    return w.getURL();
  } catch {
    return w.src ?? '';
  }
}

export const CROWD_START_URL = HABBLET_HOME_URL;
