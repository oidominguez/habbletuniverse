import { ipcMain, safeStorage, session } from 'electron';
import type { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { randomUUID } from 'crypto';
import { IPC } from '../shared/ipc';
import type {
  CaptchaSolverProvider,
  CaptchaSolverSettings,
  CrowdAccount,
  CrowdAccountInput,
  CrowdAccountPatch,
  CrowdCredentials,
  CrowdNetworkSettings,
  InterceptedHandshake,
  TorSettings,
  TrafficReport,
  TurnstileSolveRequest,
} from '../shared/crowd';
import type { AppliedProxyInfo, ProxyPhase } from '../shared/crowd';
import { GAME_SOCKET_HOSTS, crowdPartition, defaultCrowdNetworkSettings } from '../shared/crowd';
import { applyProxy, describeProxy, resetTraffic, testProxy, trafficFor } from './crowd-proxy';
import { withStickySession } from './proxy-url';
import { solveTurnstile } from './captcha-solver';
import { generateTorrc, launchTor, stopTor, torProxyUrl, torStatus } from './tor';
import { HeadlessRegistry } from './headless-client';
import { appLog } from './app-log';

interface StoredAccount extends Omit<CrowdAccount, 'proxy'> {
  /** Senha criptografada com safeStorage (DPAPI no Windows), em base64. */
  passwordEnc: string;
  /** URL do proxy (pode ter credenciais) criptografada; ausente = direto. */
  proxyEnc?: string;
}

interface CrowdSchema {
  accounts: StoredAccount[];
  solver: { provider: CaptchaSolverProvider; apiKeyEnc?: string };
  tor: TorSettings;
  network: CrowdNetworkSettings;
}

const DEFAULT_TOR: TorSettings = { enabled: false, host: '127.0.0.1', basePort: 9050, count: 20, torExePath: null };

/**
 * Cofre de contas da Multidão. Arquivo separado (`crowd.json`) para não misturar com as
 * configurações comuns e não ir junto no perfil exportável. A senha nunca sai em claro do
 * main a não ser pela chamada explícita `credentials(id)`, feita na hora de preencher o login.
 */
const store = new Store<CrowdSchema>({
  name: 'crowd',
  defaults: { accounts: [], solver: { provider: 'none' }, tor: DEFAULT_TOR, network: defaultCrowdNetworkSettings },
});

function publicView(a: StoredAccount): CrowdAccount {
  let proxy: string | null = null;
  if (a.proxyEnc) {
    try { proxy = describeProxy(decrypt(a.proxyEnc)); } catch { proxy = '(proxy ilegível)'; }
  }
  return { id: a.id, username: a.username, label: a.label, createdAt: a.createdAt, autoConnect: a.autoConnect, proxy };
}

function encrypt(password: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Criptografia do sistema indisponível; não é possível guardar a senha com segurança.');
  return safeStorage.encryptString(password).toString('base64');
}

function decrypt(enc: string): string {
  return safeStorage.decryptString(Buffer.from(enc, 'base64'));
}

function sanitizeNetwork(input: Partial<CrowdNetworkSettings> | undefined, base: CrowdNetworkSettings): CrowdNetworkSettings {
  const next = { ...base };
  if (!input) return next;
  if (input.mode === 'headless' || input.mode === 'webview') next.mode = input.mode;
  if (input.proxyScope === 'all' || input.proxyScope === 'game-only') next.proxyScope = input.proxyScope;
  if (Array.isArray(input.gameHosts)) {
    const hosts = input.gameHosts.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (hosts.length > 0) next.gameHosts = [...new Set(hosts)].slice(0, 50);
  }
  if (typeof input.autoReconnect === 'boolean') next.autoReconnect = input.autoReconnect;
  if (typeof input.proxyAfterLogin === 'boolean') next.proxyAfterLogin = input.proxyAfterLogin;
  if (typeof input.connectConcurrency === 'number' && Number.isFinite(input.connectConcurrency)) next.connectConcurrency = Math.min(10, Math.max(1, Math.round(input.connectConcurrency)));
  return next;
}

/**
 * Proxy da conta conforme a fase. "Proxy depois do login": na fase `login` a sessão fica direta (IP real
 * para o site e o Cloudflare); na fase `game` (só no modo com tela, antes de abrir o /hotel) entra o proxy
 * restrito a `game.habblet.city`. Sem tela, a fase `game` não existe: o cliente Node já usa o proxy.
 *
 * Limite conhecido (testado em 17/09/2026): o Habblet grava o IP da conta pelo SITE (login e /hotel, que
 * gera o ticket), não pela conexão do jogo. Com esta opção, as contas ficam registradas com o IP real
 * (o limite de 2 contas por IP por quarto contou as do app junto com o navegador de casa) mesmo com o
 * WebSocket saindo pelo proxy. Tentamos aplicar o proxy ao site logo após autenticar, antes do /hotel:
 * o site derrubou a sessão e recusou o login pelo IP do proxy (bloqueio anti-VPN vale para o site todo).
 * Para o jogo ver o IP do proxy, o proxy precisa passar no login (IP residencial) com esta opção DESLIGADA.
 */
async function applyAccountProxy(id: string, phase: ProxyPhase): Promise<AppliedProxyInfo> {
  const partition = crowdPartition(id);
  const network = crowdStore.networkSettings();
  const proxyUrl = crowdStore.effectiveProxyUrl(id);
  if (network.proxyAfterLogin && proxyUrl) {
    if (phase === 'login') {
      const r = await applyProxy(partition, null, network);
      return { rules: describeProxy(proxyUrl), scope: r.scope, deferred: true };
    }
    const r = await applyProxy(partition, proxyUrl, network, GAME_SOCKET_HOSTS);
    return { ...r, deferred: false };
  }
  if (phase === 'game') {
    // Sem "proxy depois do login" a sessão já está como deve desde o começo.
    const cur = crowdStore.networkSettings();
    return { rules: proxyUrl ? describeProxy(proxyUrl) : null, scope: proxyUrl ? (cur.proxyScope === 'game-only' ? 'game-only' : 'all') : 'direct', deferred: false };
  }
  const r = await applyProxy(partition, proxyUrl, network);
  return { ...r, deferred: false };
}

export const crowdStore = {
  list(): CrowdAccount[] {
    return store.get('accounts', []).map(publicView);
  },

  add(input: CrowdAccountInput): CrowdAccount {
    const username = input.username.trim();
    if (!username || !input.password) throw new Error('Usuário e senha são obrigatórios.');
    const accounts = store.get('accounts', []);
    if (accounts.some((a) => a.username.toLowerCase() === username.toLowerCase())) throw new Error(`A conta ${username} já está cadastrada.`);
    const acc: StoredAccount = {
      id: randomUUID(),
      username,
      label: (input.label ?? '').trim(),
      createdAt: Date.now(),
      autoConnect: false,
      passwordEnc: encrypt(input.password),
      proxyEnc: input.proxy?.trim() ? encrypt(input.proxy.trim()) : undefined,
    };
    store.set('accounts', [...accounts, acc]);
    return publicView(acc);
  },

  update(id: string, patch: CrowdAccountPatch): CrowdAccount {
    const accounts = store.get('accounts', []);
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error('Conta não encontrada.');
    const cur = accounts[idx];
    const next: StoredAccount = {
      ...cur,
      username: patch.username?.trim() || cur.username,
      label: patch.label !== undefined ? patch.label.trim() : cur.label,
      autoConnect: patch.autoConnect ?? cur.autoConnect,
      passwordEnc: patch.password ? encrypt(patch.password) : cur.passwordEnc,
      proxyEnc: patch.proxy === undefined ? cur.proxyEnc : patch.proxy.trim() ? encrypt(patch.proxy.trim()) : undefined,
    };
    accounts[idx] = next;
    store.set('accounts', accounts);
    return publicView(next);
  },

  remove(id: string): void {
    store.set('accounts', store.get('accounts', []).filter((a) => a.id !== id));
  },

  credentials(id: string): CrowdCredentials {
    const acc = store.get('accounts', []).find((a) => a.id === id);
    if (!acc) throw new Error('Conta não encontrada.');
    return { username: acc.username, password: decrypt(acc.passwordEnc) };
  },

  proxyUrl(id: string): string | null {
    const acc = store.get('accounts', []).find((a) => a.id === id);
    if (!acc) throw new Error('Conta não encontrada.');
    return acc.proxyEnc ? decrypt(acc.proxyEnc) : null;
  },

  solverSettings(): CaptchaSolverSettings {
    const s = store.get('solver', { provider: 'none' });
    return { provider: s.provider ?? 'none', hasKey: !!s.apiKeyEnc };
  },

  setSolver(provider: CaptchaSolverProvider, apiKey: string | null): CaptchaSolverSettings {
    const cur = store.get('solver', { provider: 'none' });
    const next = { provider, apiKeyEnc: apiKey === null ? cur.apiKeyEnc : apiKey.trim() ? encrypt(apiKey.trim()) : undefined };
    store.set('solver', next);
    return { provider: next.provider, hasKey: !!next.apiKeyEnc };
  },

  solverKey(): string {
    const s = store.get('solver', { provider: 'none' });
    return s.apiKeyEnc ? decrypt(s.apiKeyEnc) : '';
  },

  torSettings(): TorSettings {
    return { ...DEFAULT_TOR, ...store.get('tor', DEFAULT_TOR) };
  },

  setTor(patch: Partial<TorSettings>): TorSettings {
    const next = { ...this.torSettings(), ...patch };
    store.set('tor', next);
    return next;
  },

  networkSettings(): CrowdNetworkSettings {
    return sanitizeNetwork(store.get('network', defaultCrowdNetworkSettings), defaultCrowdNetworkSettings);
  },

  setNetwork(patch: Partial<CrowdNetworkSettings>): CrowdNetworkSettings {
    const next = sanitizeNetwork(patch, this.networkSettings());
    store.set('network', next);
    return next;
  },

  /**
   * Proxy efetivo da conta: proxy próprio > Tor (por índice) > direto. Em provedor residencial rotativo,
   * ganha uma sessão fixa derivada do id da conta (ver withStickySession): login, hotel e WebSocket saem
   * pelo mesmo IP, e contas diferentes por IPs diferentes.
   */
  effectiveProxyUrl(id: string): string | null {
    const own = this.proxyUrl(id);
    if (own) return withStickySession(own, id.replace(/-/g, '').slice(0, 10));
    const tor = this.torSettings();
    if (!tor.enabled) return null;
    const idx = store.get('accounts', []).findIndex((a) => a.id === id);
    return idx >= 0 ? torProxyUrl(tor, idx) : null;
  },
};

/** Clientes do jogo sem tela, um por conta. */
export const headless = new HeadlessRegistry();

async function cookieHeaderFor(partition: string, wsUrl: string): Promise<string | undefined> {
  try {
    const httpUrl = wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const cookies = await session.fromPartition(partition).cookies.get({ url: httpUrl });
    if (cookies.length === 0) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined;
  }
}

export function registerCrowdIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.CROWD_LIST, () => crowdStore.list());
  ipcMain.handle(IPC.CROWD_ADD, (_e, input: CrowdAccountInput) => crowdStore.add(input));
  ipcMain.handle(IPC.CROWD_UPDATE, (_e, id: string, patch: CrowdAccountPatch) => crowdStore.update(id, patch));
  ipcMain.handle(IPC.CROWD_REMOVE, (_e, id: string) => {
    headless.disconnect(id);
    crowdStore.remove(id);
  });
  ipcMain.handle(IPC.CROWD_CREDENTIALS, (_e, id: string) => crowdStore.credentials(id));
  ipcMain.handle(IPC.CROWD_PROXY_APPLY, async (_e, id: string, phase: unknown) => {
    const ph: ProxyPhase = phase === 'game' ? 'game' : 'login';
    const r = await applyAccountProxy(id, ph);
    appLog('proxy', `${id.slice(0, 8)} fase=${ph} regras=${r.rules ?? 'direto'} escopo=${r.scope}${r.deferred ? ' (adiado: login pelo IP real)' : ''}`);
    return r;
  });
  ipcMain.handle(IPC.CROWD_PROXY_TEST, (_e, id: string) => testProxy(crowdPartition(id), crowdStore.effectiveProxyUrl(id)));
  ipcMain.handle(IPC.CROWD_SOLVER_GET, () => crowdStore.solverSettings());
  ipcMain.handle(IPC.CROWD_SOLVER_SET, (_e, provider: CaptchaSolverProvider, apiKey: string | null) => crowdStore.setSolver(provider, apiKey));
  ipcMain.handle(IPC.CROWD_SOLVER_SOLVE, (_e, req: TurnstileSolveRequest) => solveTurnstile(crowdStore.solverSettings().provider, crowdStore.solverKey(), req));
  ipcMain.handle(IPC.CROWD_TOR_GET, () => ({ settings: crowdStore.torSettings(), status: torStatus(crowdStore.torSettings()) }));
  ipcMain.handle(IPC.CROWD_TOR_SET, (_e, patch: Partial<TorSettings>) => { const settings = crowdStore.setTor(patch); return { settings, status: torStatus(settings) }; });
  ipcMain.handle(IPC.CROWD_TOR_TORRC, () => generateTorrc(crowdStore.torSettings()));
  ipcMain.handle(IPC.CROWD_TOR_LAUNCH, () => launchTor(crowdStore.torSettings()));
  ipcMain.handle(IPC.CROWD_TOR_STOP, () => stopTor());

  ipcMain.handle(IPC.CROWD_NETWORK_GET, () => crowdStore.networkSettings());
  ipcMain.handle(IPC.CROWD_NETWORK_SET, (_e, patch: Partial<CrowdNetworkSettings>) => crowdStore.setNetwork(patch));

  ipcMain.handle(IPC.CROWD_TRAFFIC_GET, (): TrafficReport[] =>
    crowdStore.list().map((a) => {
      const t = trafficFor(crowdPartition(a.id));
      return { accountId: a.id, since: t.since, metered: t.metered, bytesViaProxy: t.bytesViaProxy, bytesDirect: t.bytesDirect, requests: t.requests, hosts: t.hosts, headless: headless.status(a.id) };
    }),
  );
  ipcMain.handle(IPC.CROWD_TRAFFIC_RESET, () => resetTraffic());

  /* ------------------------------ cliente sem tela ------------------------------ */
  ipcMain.handle(IPC.CROWD_HEADLESS_CONNECT, async (_e, id: string, hs: InterceptedHandshake) => {
    if (!hs || !Array.isArray(hs.packets) || hs.packets.length === 0) throw new Error('handshake vazio');
    const partition = crowdPartition(id);
    const ses = session.fromPartition(partition);
    const proxyUrl = crowdStore.effectiveProxyUrl(id);
    const short = id.slice(0, 8);
    appLog('headless', `${short} conectando ${hs.url} handshake=[${hs.packets.map((p) => p.header).join(',')}] proxy=${proxyUrl ? describeProxy(proxyUrl) : 'direto'}`);
    headless.connect({
      id,
      url: hs.url,
      origin: hs.origin,
      userAgent: hs.userAgent || ses.getUserAgent(),
      cookie: await cookieHeaderFor(partition, hs.url),
      proxyUrl,
      handshake: hs.packets,
      onEvent: (ev) => {
        if (ev.kind === 'open') appLog('headless', `${short} socket aberto`);
        else if (ev.kind === 'close') appLog('headless', `${short} socket fechado code=${ev.code} reason="${ev.reason}" byUser=${ev.byUser}`);
        else if (ev.kind === 'error') appLog('headless', `${short} erro: ${ev.message}`);
        else if (ev.kind === 'stats') appLog('headless', `${short} bytes in=${ev.bytesIn} out=${ev.bytesOut}`);
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(IPC.CROWD_HEADLESS_EVENT, ev);
      },
    });
  });
  ipcMain.on(IPC.CROWD_HEADLESS_SEND, (_e, id: string, header: number, bodyBase64: string) => {
    headless.send(id, header | 0, Buffer.from(bodyBase64 || '', 'base64'));
  });
  ipcMain.handle(IPC.CROWD_HEADLESS_DISCONNECT, (_e, id: string) => {
    appLog('headless', `${id.slice(0, 8)} desconectar (pedido do app)`);
    headless.disconnect(id);
  });
}
