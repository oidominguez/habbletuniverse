/**
 * Contrato IPC entre o processo principal do Electron e o renderer (React).
 *
 * Este arquivo é importado pelos dois lados, então só pode conter tipos e
 * constantes puras — nada de `electron`, `fs` ou APIs de DOM.
 */
import type { PersistedSettings, SettingsPatch } from './addon-config';
import type { FurniCatalogResult } from './furnidata';
import type {
  AppliedProxyInfo,
  ProxyPhase,
  CaptchaSolverProvider,
  CaptchaSolverSettings,
  TorSettings,
  TorStatus,
  CrowdAccount,
  CrowdAccountInput,
  CrowdAccountPatch,
  CrowdCredentials,
  CrowdNetworkSettings,
  HeadlessEvent,
  InterceptedHandshake,
  ProxyTestResult,
  TrafficReport,
  TurnstileSolveRequest,
  TurnstileSolveResult,
} from './crowd';

/** Nomes dos canais IPC. Centralizados aqui para evitar strings soltas. */
export const IPC = {
  /** renderer → main: pede a versão do app (package.json). */
  APP_GET_VERSION: 'app:get-version',
  /** renderer → main: abre uma URL no navegador padrão do sistema. */
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  /** main → renderer: a página do webview tentou abrir uma nova janela (window.open / target=_blank). */
  WEBVIEW_OPEN_URL: 'webview:open-url',
  /** renderer → main: caminho (file://) do preload que o <webview> deve carregar. */
  WEBVIEW_GET_PRELOAD: 'webview:get-preload',
  /** main → renderer: atalho de teclado do app pressionado dentro do webview (Ctrl+K/J/,). */
  APP_SHORTCUT: 'app:shortcut',

  /** renderer → main: lê todas as configurações persistidas. */
  SETTINGS_GET: 'settings:get',
  /** renderer → main: aplica um patch parcial e devolve o estado completo resultante. */
  SETTINGS_UPDATE: 'settings:update',
  /** renderer → main: volta tudo ao padrão e devolve o estado resultante. */
  SETTINGS_RESET: 'settings:reset',
  /** renderer → main: abre diálogo "salvar como" e grava um perfil JSON. */
  SETTINGS_EXPORT: 'settings:export',
  /** renderer → main: abre diálogo "abrir", lê e aplica um perfil JSON; devolve o estado resultante. */
  SETTINGS_IMPORT: 'settings:import',

  /** renderer → main (one-way): acrescenta uma linha ao log persistente do app (<userData>/logs). */
  LOG_APPEND: 'log:append',
  /** renderer → main: caminho do arquivo de log do dia. */
  LOG_PATH: 'log:path',

  /** renderer → main: grava um marcador do usuário no arquivo de captura do protocolo. */
  PROTO_MARKER: 'protocol:marker',
  /** renderer → main: caminho do arquivo NDJSON onde a sessão atual está sendo gravada. */
  PROTO_CAPTURE_PATH: 'protocol:capture-path',

  /** renderer → main: catálogo de mobis sentáveis/deitáveis (furnidata do hotel, com cache em disco). */
  GAME_FURNIDATA_GET: 'game:furnidata:get',

  /** Multidão: cofre de contas (senhas criptografadas no main). */
  CROWD_LIST: 'crowd:list',
  CROWD_ADD: 'crowd:add',
  CROWD_UPDATE: 'crowd:update',
  CROWD_REMOVE: 'crowd:remove',
  CROWD_CREDENTIALS: 'crowd:credentials',
  /** Aplica o proxy da conta à partition dela (antes de montar o webview). */
  CROWD_PROXY_APPLY: 'crowd:proxy:apply',
  /** Descobre o IP de saída da partition (testa o proxy). */
  CROWD_PROXY_TEST: 'crowd:proxy:test',
  /** Resolvedor de captcha: configuração e resolução de um Turnstile. */
  CROWD_SOLVER_GET: 'crowd:solver:get',
  CROWD_SOLVER_SET: 'crowd:solver:set',
  CROWD_SOLVER_SOLVE: 'crowd:solver:solve',
  CROWD_TOR_GET: 'crowd:tor:get',
  CROWD_TOR_SET: 'crowd:tor:set',
  CROWD_TOR_TORRC: 'crowd:tor:torrc',
  CROWD_TOR_LAUNCH: 'crowd:tor:launch',
  CROWD_TOR_STOP: 'crowd:tor:stop',
  /** Rede da Multidão: modo de transporte (sem tela / webview), escopo do proxy, reconexão. */
  CROWD_NETWORK_GET: 'crowd:network:get',
  CROWD_NETWORK_SET: 'crowd:network:set',
  /** Medidor de tráfego por conta (HTTP por host + WebSocket do cliente sem tela). */
  CROWD_TRAFFIC_GET: 'crowd:traffic:get',
  CROWD_TRAFFIC_RESET: 'crowd:traffic:reset',
  /** Cliente do jogo sem tela (main): conectar com o handshake interceptado, enviar pacote, desconectar. */
  CROWD_HEADLESS_CONNECT: 'crowd:headless:connect',
  CROWD_HEADLESS_SEND: 'crowd:headless:send',
  CROWD_HEADLESS_DISCONNECT: 'crowd:headless:disconnect',
  /** main → renderer: eventos e pacotes do cliente sem tela. */
  CROWD_HEADLESS_EVENT: 'crowd:headless:event',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Função para cancelar uma inscrição em evento vindo do main. */
export type Unsubscribe = () => void;

/** Resultado de exportar/importar perfil. `cancelled` quando o usuário fechou o diálogo. */
export type ProfileFileResult =
  | { ok: true; path: string; settings: PersistedSettings }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * API exposta ao renderer em `window.habblet` pelo preload (contextBridge).
 * O renderer só enxerga isto; não tem acesso a Node nem a `ipcRenderer` direto.
 */
export interface HabbletApi {
  /** Versão do aplicativo, lida do package.json pelo main. */
  getAppVersion(): Promise<string>;
  /** Abre uma URL http(s) no navegador padrão do sistema. */
  openExternal(url: string): Promise<void>;
  /**
   * Inscreve-se para receber URLs que a página do webview tentou abrir em nova janela.
   * O renderer decide o que fazer (normalmente carregar no próprio webview).
   */
  onWebviewOpenUrl(callback: (url: string) => void): Unsubscribe;
  /** URL file:// do preload do webview (electron/webview-preload.ts compilado). */
  getWebviewPreloadPath(): Promise<string>;
  /** Atalhos do app capturados enquanto o foco está no jogo. `key` em minúsculas: 'k', 'j', ','. */
  onShortcut(callback: (key: string) => void): Unsubscribe;

  log: {
    /** Acrescenta uma linha ao log em disco (sem esperar resposta). `source` curto, ex.: 'multidão', 'addons'. */
    append(source: string, message: string): void;
    /** Caminho do arquivo de log do dia. */
    path(): Promise<string>;
  };

  settings: {
    get(): Promise<PersistedSettings>;
    update(patch: SettingsPatch): Promise<PersistedSettings>;
    reset(): Promise<PersistedSettings>;
    exportProfile(): Promise<ProfileFileResult>;
    importProfile(): Promise<ProfileFileResult>;
  };

  protocol: {
    /** Grava um marcador (texto + horário) no arquivo de captura da sessão. */
    marker(text: string): Promise<void>;
    /** Caminho do NDJSON da sessão atual (toda a captura é gravada ali, em disco). */
    capturePath(): Promise<string>;
  };

  game: {
    /** Catálogo de mobis sentáveis/deitáveis do hotel (furnidata compactado; `force` baixa de novo). */
    furnidata(force?: boolean): Promise<FurniCatalogResult>;
  };

  crowd: {
    list(): Promise<CrowdAccount[]>;
    add(input: CrowdAccountInput): Promise<CrowdAccount>;
    update(id: string, patch: CrowdAccountPatch): Promise<CrowdAccount>;
    remove(id: string): Promise<void>;
    /** Senha em claro, só para preencher o login; não guardar. */
    credentials(id: string): Promise<CrowdCredentials>;
    /**
     * Configura o proxy da conta na sessão dela conforme a fase (`login` = antes do webview carregar;
     * `game` = antes de abrir o hotel, usado pelo "proxy depois do login" no modo com tela).
     */
    applyProxy(id: string, phase?: ProxyPhase): Promise<AppliedProxyInfo>;
    /** IP de saída visto por essa conta (pelo proxy, se houver). */
    testProxy(id: string): Promise<ProxyTestResult>;
    /** Resolvedor de captcha (2Captcha / CapSolver) com a chave do usuário. */
    getSolver(): Promise<CaptchaSolverSettings>;
    setSolver(provider: CaptchaSolverProvider, apiKey: string | null): Promise<CaptchaSolverSettings>;
    solveTurnstile(req: TurnstileSolveRequest): Promise<TurnstileSolveResult>;
    /** Modo Tor: um IP de saída por conta via uma SocksPort por conta. */
    getTor(): Promise<{ settings: TorSettings; status: TorStatus }>;
    setTor(patch: Partial<TorSettings>): Promise<{ settings: TorSettings; status: TorStatus }>;
    generateTorrc(): Promise<{ path: string; ports: number[] }>;
    launchTor(): Promise<TorStatus>;
    stopTor(): Promise<TorStatus>;
    /** Rede: modo sem tela / webview, escopo do proxy (só jogo / tudo), hosts do jogo, reconexão. */
    getNetwork(): Promise<CrowdNetworkSettings>;
    setNetwork(patch: Partial<CrowdNetworkSettings>): Promise<CrowdNetworkSettings>;
    /** Tráfego aproximado por conta (HTTP por host; WebSocket no modo sem tela). */
    getTraffic(): Promise<TrafficReport[]>;
    resetTraffic(): Promise<void>;
    /** Cliente sem tela: conecta ao jogo pelo proxy da conta com o handshake interceptado do cliente Nitro. */
    headlessConnect(id: string, handshake: InterceptedHandshake): Promise<void>;
    /** Envia um pacote (header + corpo base64) pela conexão sem tela da conta. Sem resposta (fire-and-forget). */
    headlessSend(id: string, header: number, bodyBase64: string): void;
    headlessDisconnect(id: string): Promise<void>;
    /** Eventos do cliente sem tela: abertura, pacotes, fechamento, erro, bytes. */
    onHeadlessEvent(callback: (ev: HeadlessEvent) => void): Unsubscribe;
  };
}
