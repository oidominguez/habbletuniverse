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
  ProxyPoolAddResult,
  ProxyPoolEntry,
  ProxyPoolPatch,
  ProxyPoolStatus,
  TorSettings,
  TrafficReport,
  TurnstileSolveRequest,
} from '../shared/crowd';
import type { AppliedProxyInfo, ProxyPhase } from '../shared/crowd';
import { GAME_SOCKET_HOSTS, crowdPartition, defaultCrowdNetworkSettings } from '../shared/crowd';
import { applyProxy, describeProxy, resetTraffic, testProxy, trafficFor } from './crowd-proxy';
import { withStickySession } from './proxy-url';
import { parseProxyPoolText } from './proxy-pool';
import { solveTurnstile } from './captcha-solver';
import { generateTorrc, launchTor, stopTor, torProxyUrl, torStatus } from './tor';
import { HeadlessRegistry } from './headless-client';
import { appLog } from './app-log';

interface StoredAccount extends Omit<CrowdAccount, 'proxy' | 'proxyId' | 'hasOwnProxy'> {
  /** Senha criptografada com safeStorage (DPAPI no Windows), em base64. */
  passwordEnc: string;
  /** URL do proxy próprio (pode ter credenciais) criptografada; ausente = sem proxy próprio. */
  proxyEnc?: string;
  /** Item do pool escolhido no seletor da conta; ausente = não usa o pool. Tem prioridade sobre `proxyEnc`. */
  proxyId?: string;
}

/** Item do pool de proxies em disco: URL criptografada + o que se aprendeu sobre ele. */
interface StoredProxy {
  id: string;
  urlEnc: string;
  /** Identidade sem senha (esquema, usuário, host, porta), para não cadastrar o mesmo duas vezes. */
  key: string;
  display: string;
  label: string;
  createdAt: number;
  status: ProxyPoolStatus;
  statusAt?: number;
  note?: string;
  lastIp?: string;
}

interface CrowdSchema {
  accounts: StoredAccount[];
  proxies: StoredProxy[];
  solver: { provider: CaptchaSolverProvider; apiKeyEnc?: string };
  tor: TorSettings;
  network: CrowdNetworkSettings;
}

const DEFAULT_TOR: TorSettings = { enabled: false, host: '127.0.0.1', basePort: 9050, count: 20, torExePath: null };
const POOL_STATUSES: readonly ProxyPoolStatus[] = ['unknown', 'ok', 'blocked', 'error'];
const MAX_POOL = 2000;

/**
 * Cofre de contas da Multidão. Arquivo separado (`crowd.json`) para não misturar com as
 * configurações comuns e não ir junto no perfil exportável. A senha nunca sai em claro do
 * main a não ser pela chamada explícita `credentials(id)`, feita na hora de preencher o login.
 */
const store = new Store<CrowdSchema>({
  name: 'crowd',
  defaults: { accounts: [], proxies: [], solver: { provider: 'none' }, tor: DEFAULT_TOR, network: defaultCrowdNetworkSettings },
});

function poolEntries(): StoredProxy[] {
  const list = store.get('proxies', []);
  return Array.isArray(list) ? list : [];
}

function poolView(p: StoredProxy): ProxyPoolEntry {
  let description: string;
  try { description = describeProxy(decrypt(p.urlEnc)); } catch { description = '(proxy ilegível)'; }
  return {
    id: p.id,
    display: p.display,
    description,
    label: p.label,
    createdAt: p.createdAt,
    status: POOL_STATUSES.includes(p.status) ? p.status : 'unknown',
    statusAt: p.statusAt ?? null,
    note: p.note ?? null,
    lastIp: p.lastIp ?? null,
  };
}

/**
 * Conta como o renderer a vê. `proxy` descreve o proxy EFETIVO: o item do pool escolhido tem prioridade;
 * sem ele, o proxy próprio digitado na conta. Um `proxyId` que aponte para um item já removido do pool é
 * tratado como "sem pool" (a conta cai no proxy próprio ou no IP real, e o seletor mostra isso).
 */
function publicView(a: StoredAccount, pool: StoredProxy[] = poolEntries()): CrowdAccount {
  const poolItem = a.proxyId ? pool.find((p) => p.id === a.proxyId) : undefined;
  let proxy: string | null = null;
  const enc = poolItem?.urlEnc ?? a.proxyEnc;
  if (enc) {
    try { proxy = describeProxy(decrypt(enc)); } catch { proxy = '(proxy ilegível)'; }
  }
  return { id: a.id, username: a.username, label: a.label, createdAt: a.createdAt, autoConnect: a.autoConnect, proxy, proxyId: poolItem ? poolItem.id : null, hasOwnProxy: !!a.proxyEnc };
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
    const pool = poolEntries();
    return store.get('accounts', []).map((a) => publicView(a, pool));
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
    if (patch.proxyId && !poolEntries().some((p) => p.id === patch.proxyId)) throw new Error('Esse proxy não está mais no pool.');
    const next: StoredAccount = {
      ...cur,
      username: patch.username?.trim() || cur.username,
      label: patch.label !== undefined ? patch.label.trim() : cur.label,
      autoConnect: patch.autoConnect ?? cur.autoConnect,
      passwordEnc: patch.password ? encrypt(patch.password) : cur.passwordEnc,
      proxyEnc: patch.proxy === undefined ? cur.proxyEnc : patch.proxy.trim() ? encrypt(patch.proxy.trim()) : undefined,
      proxyId: patch.proxyId === undefined ? cur.proxyId : patch.proxyId ?? undefined,
    };
    // Digitar um proxy próprio tira a conta do pool: o que foi digitado é o que vale.
    if (patch.proxy !== undefined && patch.proxy.trim() && patch.proxyId === undefined) next.proxyId = undefined;
    accounts[idx] = next;
    store.set('accounts', accounts);
    return publicView(next);
  },

  /* ------------------------------------ pool de proxies ------------------------------------ */

  listProxies(): ProxyPoolEntry[] {
    return poolEntries().map(poolView);
  },

  /** Cola uma lista (um por linha). Repetidos (mesma identidade) não entram de novo; inválidos voltam com o motivo. */
  addProxies(text: string): ProxyPoolAddResult {
    const parsed = parseProxyPoolText(text);
    const pool = poolEntries();
    const known = new Set(pool.map((p) => p.key));
    const added: StoredProxy[] = [];
    let existing = 0;
    for (const e of parsed.entries) {
      if (known.has(e.key)) { existing++; continue; }
      if (pool.length + added.length >= MAX_POOL) break;
      known.add(e.key);
      added.push({ id: randomUUID(), urlEnc: encrypt(e.url), key: e.key, display: e.display, label: '', createdAt: Date.now(), status: 'unknown' });
    }
    if (added.length) store.set('proxies', [...pool, ...added]);
    return { added: added.map(poolView), existing, duplicates: parsed.duplicates, invalid: parsed.invalid };
  },

  updateProxy(id: string, patch: ProxyPoolPatch): ProxyPoolEntry {
    const pool = poolEntries();
    const idx = pool.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error('Proxy não encontrado no pool.');
    const cur = pool[idx];
    const next: StoredProxy = { ...cur };
    if (typeof patch.label === 'string') next.label = patch.label.trim().slice(0, 60);
    if (patch.status && POOL_STATUSES.includes(patch.status)) {
      next.status = patch.status;
      next.statusAt = Date.now();
      // Nota nova só junto com status novo; `null` limpa, ausente mantém.
      if (patch.note !== undefined) next.note = patch.note ? patch.note.slice(0, 200) : undefined;
      else if (patch.status === 'unknown') next.note = undefined;
    } else if (patch.note !== undefined) next.note = patch.note ? patch.note.slice(0, 200) : undefined;
    if (patch.lastIp !== undefined) next.lastIp = patch.lastIp || undefined;
    pool[idx] = next;
    store.set('proxies', pool);
    return poolView(next);
  },

  /** Remove do pool e desliga as contas que apontavam para ele (elas voltam ao proxy próprio, se houver, ou ao IP real). */
  removeProxy(id: string): void {
    store.set('proxies', poolEntries().filter((p) => p.id !== id));
    const accounts = store.get('accounts', []);
    let changed = false;
    for (const a of accounts) if (a.proxyId === id) { delete a.proxyId; changed = true; }
    if (changed) store.set('accounts', accounts);
  },

  poolProxyUrl(id: string): string | null {
    const p = poolEntries().find((x) => x.id === id);
    return p ? decrypt(p.urlEnc) : null;
  },

  remove(id: string): void {
    store.set('accounts', store.get('accounts', []).filter((a) => a.id !== id));
  },

  credentials(id: string): CrowdCredentials {
    const acc = store.get('accounts', []).find((a) => a.id === id);
    if (!acc) throw new Error('Conta não encontrada.');
    return { username: acc.username, password: decrypt(acc.passwordEnc) };
  },

  /** Proxy configurado na conta: o item do pool escolhido, senão o próprio digitado, senão null. */
  proxyUrl(id: string): string | null {
    const acc = store.get('accounts', []).find((a) => a.id === id);
    if (!acc) throw new Error('Conta não encontrada.');
    if (acc.proxyId) {
      const fromPool = this.poolProxyUrl(acc.proxyId);
      if (fromPool) return fromPool;
    }
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

  /* ------------------------------ pool de proxies ------------------------------ */
  ipcMain.handle(IPC.CROWD_PROXIES_LIST, () => crowdStore.listProxies());
  ipcMain.handle(IPC.CROWD_PROXIES_ADD, (_e, text: unknown) => {
    const r = crowdStore.addProxies(typeof text === 'string' ? text : '');
    appLog('proxy', `pool: +${r.added.length} (${r.existing} já cadastrados, ${r.duplicates} repetidos no texto, ${r.invalid.length} inválidos)`);
    return r;
  });
  ipcMain.handle(IPC.CROWD_PROXIES_UPDATE, (_e, id: string, patch: unknown) => {
    const p = typeof patch === 'object' && patch !== null ? (patch as ProxyPoolPatch) : {};
    const r = crowdStore.updateProxy(id, p);
    if (p.status) appLog('proxy', `pool: ${r.display} → ${r.status}${r.note ? ` (${r.note})` : ''}`);
    return r;
  });
  ipcMain.handle(IPC.CROWD_PROXIES_REMOVE, (_e, id: string) => crowdStore.removeProxy(id));
  // Teste de um item do pool sem conta: sai pelo proxy em Node (mesmo caminho do cliente sem tela) e grava o IP visto.
  ipcMain.handle(IPC.CROWD_PROXIES_TEST, async (_e, id: string) => {
    const url = crowdStore.poolProxyUrl(id);
    if (!url) return { ok: false, error: 'Proxy não encontrado no pool.' };
    const r = await testProxy(crowdPartition('pool-test'), url);
    if (r.ok) crowdStore.updateProxy(id, { lastIp: r.ip });
    else {
      // Não deu para sair por ele: marca `error`, mas nunca rebaixa um `blocked` (esse veio do site, é informação melhor).
      const cur = crowdStore.listProxies().find((p) => p.id === id);
      if (cur && cur.status !== 'blocked') crowdStore.updateProxy(id, { status: 'error', note: r.error });
    }
    return r;
  });
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
