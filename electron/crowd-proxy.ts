import { app, net, session } from 'electron';
import type { Session } from 'electron';
import * as https from 'https';
import type { CrowdNetworkSettings, ProxyTestResult, TrafficHostStat } from '../shared/crowd';
import { agentFor } from './headless-client';
import { buildPac, isGameHost, pacDirective, parseProxy } from './proxy-url';
import type { ParsedProxy } from './proxy-url';
import { appLog } from './app-log';
export { describeProxy, parseProxy } from './proxy-url';
export type { ParsedProxy } from './proxy-url';

/**
 * Proxy por sessão da Multidão. Cada conta tem uma partition própria; o Chromium aplica o
 * proxy a TODO o tráfego dela (HTTP do site e o WebSocket do jogo). Suporta http://, https://,
 * socks5:// e socks4://, com usuário e senha na URL (autenticação respondida no evento `login`;
 * atenção: o Chromium não autentica SOCKS5 — o cliente sem tela, em Node, autentica).
 *
 * Escopo `game-only`: um script PAC manda só os hosts do jogo/site pelo proxy e o resto (assets,
 * imagens, CDN) direto — é o que corta o consumo do plano do proxy no modo com tela. No modo sem
 * tela o webview morre depois do login, então sobra só o WebSocket, que vai pelo proxy sempre.
 *
 * O medidor de tráfego (webRequest) só fica ligado sem senha no proxy — ver setTrafficMeter.
 */

interface ProxyCreds {
  username: string;
  password: string;
  host: string;
  port: number;
}

/** Credenciais de proxy por partition, para responder ao desafio 407. */
const proxyAuth = new Map<string, ProxyCreds>();
let loginHookInstalled = false;

function shortPartition(partition: string | undefined): string {
  return partition ? partition.replace(/^persist:crowd-/, '').slice(0, 8) : '?';
}

/** 407 seguidos do mesmo proxy em poucos segundos = usuário/senha recusados (o Chromium repete até ERR_TOO_MANY_RETRIES). */
const REJECT_WINDOW_MS = 5000;
const REJECT_LIMIT = 3;
const rejects = new Map<string, { n: number; since: number }>();

/** Marca um 407 do proxy; true quando já passou do limite na janela (credenciais recusadas). */
function noteChallenge(proxyKey: string, now: number): boolean {
  const r = rejects.get(proxyKey);
  if (!r || now - r.since > REJECT_WINDOW_MS) {
    rejects.set(proxyKey, { n: 1, since: now });
    return false;
  }
  r.n++;
  return r.n > REJECT_LIMIT;
}

/** Último diagnóstico de credenciais recusadas por proxy (host:porta), para o painel. */
export function proxyAuthRejected(host: string, port: number): boolean {
  const r = rejects.get(`${host}:${port}`);
  return !!r && r.n > REJECT_LIMIT && Date.now() - r.since < 60_000;
}

function installLoginHook(): void {
  if (loginHookInstalled) return;
  loginHookInstalled = true;
  app.on('login', (event, webContents, request, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    // O WebSocket do jogo pode chegar sem webContents; aí casamos pelo host:porta do proxy.
    const partition = webContents ? partitionOf(webContents.session) : undefined;
    let creds = partition ? proxyAuth.get(partition) : undefined;
    if (!creds) creds = [...proxyAuth.values()].find((c) => c.host === authInfo.host && c.port === authInfo.port);
    const proxyKey = `${authInfo.host}:${authInfo.port}`;
    const rejected = creds ? noteChallenge(proxyKey, Date.now()) : false;
    if (rejected) {
      // Já mandamos as credenciais várias vezes e o proxy insiste no 407: não adianta repetir. Cancela a
      // autenticação (a requisição falha com 407 em vez de ficar em loop) e deixa o diagnóstico registrado.
      const r = rejects.get(proxyKey);
      if (r && r.n === REJECT_LIMIT + 1) appLog('proxy', `${shortPartition(partition)} ${proxyKey} recusou usuário/senha ${REJECT_LIMIT} vezes seguidas: confira as credenciais no formato do provedor (ex.: Oxylabs usa "user-<login>" no usuário).`);
      event.preventDefault();
      callback();
      return;
    }
    appLog('proxy', `${shortPartition(partition)} desafio 407 de ${proxyKey} (${authInfo.scheme}) para ${request.url.slice(0, 60)} → ${creds ? 'credenciais enviadas' : 'SEM credenciais'}`);
    if (!creds) return;
    event.preventDefault();
    callback(creds.username, creds.password);
  });
}

/**
 * Aquece o cache de autenticação do proxy: uma requisição HTTP pela sessão, para um host que o PAC
 * manda pelo proxy, recebe o 407, responde com as credenciais e deixa a entrada no HttpAuthCache do
 * contexto de rede. A partir daí o CONNECT do WebSocket do jogo já sai com Proxy-Authorization, sem
 * depender do evento `login` para WebSocket (visto em 17/09/2026: o handshake pelo proxy autenticado
 * fechava com 1006 em 0,5 s numa sessão nova, e passava quando o site inteiro já tinha ido pelo proxy).
 */
function warmProxyAuth(ses: Session, p: ParsedProxy, host: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (msg: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(msg);
    };
    let challenged = false;
    let req: Electron.ClientRequest;
    try {
      req = net.request({ url: `https://${host}/`, method: 'HEAD', session: ses, useSessionCookies: false });
    } catch (e) {
      finish(`falhou: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const timer = setTimeout(() => {
      req.abort();
      finish('timeout');
    }, timeoutMs);
    req.on('login', (authInfo, cb) => {
      challenged = true;
      if (authInfo.isProxy) cb(p.username ?? '', p.password ?? '');
      else cb();
    });
    req.on('response', (res) => {
      res.on('data', () => {});
      res.on('end', () => finish(challenged ? `ok (HTTP ${res.statusCode}, credenciais aceitas)` : `sem desafio (HTTP ${res.statusCode}; cache já quente ou proxy sem senha)`));
      res.on('error', () => finish('erro na resposta'));
    });
    req.on('error', (e) => finish(`falhou: ${e.message}`));
    req.end();
  });
}

const sessionPartitions = new WeakMap<Session, string>();
function partitionOf(ses: Session): string | undefined {
  return sessionPartitions.get(ses);
}

function sessionFor(partition: string): Session {
  const ses = session.fromPartition(partition);
  sessionPartitions.set(ses, partition);
  return ses;
}

/** Partitions que receberam proxy nesta execução (para saber quando limpar). */
const proxied = new Set<string>();
/** Regras em vigor por partition (para o medidor saber o que sai pelo proxy). */
const scopeByPartition = new Map<string, { scope: 'all' | 'game-only' | 'direct'; gameHosts: readonly string[] }>();

export interface AppliedProxy {
  /** Regras aplicadas sem credenciais, ou null = conexão direta. */
  rules: string | null;
  scope: 'all' | 'game-only' | 'direct';
  /** Aviso para o painel (ex.: o proxy recusou usuário e senha no aquecimento). */
  warning?: string;
}

/**
 * Aplica (ou remove, com url vazia) o proxy da partition. Deve rodar antes do webview carregar (ou antes
 * de navegar para o hotel, no "proxy depois do login"). `hostsOverride` restringe o PAC a esses hosts.
 */
export async function applyProxy(partition: string, proxyUrl: string | null, network: CrowdNetworkSettings, hostsOverride?: readonly string[]): Promise<AppliedProxy> {
  installLoginHook();
  // Atenção: NÃO trocar o user agent aqui. Testado em 13/09/2026: com um UA de Chrome falso o
  // Cloudflare passou a servir a página de desafio ("Confirme que é humano") em toda sessão nova,
  // enquanto o UA padrão do Electron entra direto no site. O mismatch UA × client hints denuncia.
  const ses = sessionFor(partition);
  const parsed = proxyUrl ? parseProxy(proxyUrl) : null;
  // Medidor só quando o proxy não exige senha: com credenciais, o listener de webRequest derruba o app
  // no 407 do WebSocket do jogo (ver setTrafficMeter). Tem de sair ANTES de o webview abrir o hotel.
  setTrafficMeter(partition, ses, !parsed?.username);
  if (!parsed) {
    proxyAuth.delete(partition);
    scopeByPartition.set(partition, { scope: 'direct', gameHosts: network.gameHosts });
    // Sem proxy, a sessão fica exatamente como a do jogo principal (sem mexer no setProxy):
    // testado em 13/09/2026, `setProxy({ mode: 'direct' })` numa sessão nova fez o Cloudflare servir
    // a página de desafio em toda conexão, enquanto a sessão intocada entra direto. Só voltamos ao
    // modo do sistema se essa partition já teve proxy antes.
    if (proxied.has(partition)) {
      await ses.setProxy({ mode: 'system' });
      await ses.closeAllConnections();
      proxied.delete(partition);
    }
    return { rules: null, scope: 'direct' };
  }
  proxied.add(partition);
  const p = parsed;
  const rules = `${p.scheme}://${p.host}:${p.port}`;
  if (p.username) proxyAuth.set(partition, { username: p.username, password: p.password ?? '', host: p.host, port: p.port });
  else proxyAuth.delete(partition);
  const hosts = hostsOverride ?? network.gameHosts;
  if ((hostsOverride || network.proxyScope === 'game-only') && hosts.length > 0) {
    const pac = buildPac(pacDirective(p), hosts);
    await ses.setProxy({ mode: 'pac_script', pacScript: 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pac, 'utf8').toString('base64') });
    scopeByPartition.set(partition, { scope: 'game-only', gameHosts: hosts });
  } else {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules, proxyBypassRules: '<local>' });
    scopeByPartition.set(partition, { scope: 'all', gameHosts: network.gameHosts });
  }
  await ses.closeAllConnections();
  let warning: string | undefined;
  if (p.username && (p.scheme === 'http' || p.scheme === 'https') && hosts.length > 0) {
    // De preferência o host do jogo (nginx sem Cloudflare): só interessa o 407 do proxy, não a página.
    const warmHost = hosts.find((h) => h.startsWith('game.')) ?? hosts[0];
    const result = await warmProxyAuth(ses, p, warmHost);
    appLog('proxy', `${shortPartition(partition)} aquecimento da autenticação via ${warmHost}: ${result}`);
    if (proxyAuthRejected(p.host, p.port) || /TOO_MANY_RETRIES|407/.test(result)) {
      warning = `o proxy ${p.host}:${p.port} recusou usuário e senha (407 repetido). Confira as credenciais no formato do provedor; a conta vai falhar ao carregar o site.`;
    } else if (result.startsWith('falhou') || result === 'timeout') {
      warning = `não deu para sair pelo proxy ${p.host}:${p.port} (${result}).`;
    }
  }
  return { rules, scope: hostsOverride || network.proxyScope === 'game-only' ? 'game-only' : 'all', warning };
}

const IP_RE = /\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,}/i;

/**
 * IP de saída da conta. Com proxy, o teste sai PELO PROXY em Node (mesmo agente do cliente sem tela):
 * é o IP que o servidor do jogo vê tanto sem tela quanto com tela (o PAC manda game.habblet.city pelo
 * mesmo proxy). Testar pela sessão do webview não serve: com "proxy depois do login" ou escopo "só jogo"
 * os hosts de teste saem DIRETO e mostram o IP real, o que fez parecer que o proxy não valia (17/09/2026).
 * Sem proxy, a sessão vai direto e o resultado é o IP real, dito como tal.
 */
export async function testProxy(partition: string, proxyUrl: string | null, timeoutMs = 12000): Promise<ProxyTestResult> {
  if (proxyUrl) return testViaProxy(proxyUrl, timeoutMs);
  const ses = sessionFor(partition);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
      try {
        const res = await ses.fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) continue;
        const m = (await res.text()).match(IP_RE);
        if (m) return { ok: true, ip: m[0].trim(), via: 'direto' };
      } catch {
        /* tenta o próximo */
      }
    }
    return { ok: false, error: 'não foi possível obter o IP (timeout ou bloqueio)' };
  } finally {
    clearTimeout(timer);
  }
}

function testViaProxy(proxyUrl: string, timeoutMs: number): Promise<ProxyTestResult> {
  let agent: ReturnType<typeof agentFor>;
  try {
    agent = agentFor(proxyUrl);
  } catch (e) {
    return Promise.resolve({ ok: false, error: 'proxy inválido: ' + (e instanceof Error ? e.message : String(e)) });
  }
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { agent, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (body.length < 4096) body += d;
      });
      res.on('end', () => {
        const m = body.match(IP_RE);
        if (res.statusCode === 200 && m) resolve({ ok: true, ip: m[0], via: 'proxy' });
        else resolve({ ok: false, error: `o proxy respondeu HTTP ${res.statusCode ?? '?'} ao teste de IP` });
      });
      res.on('error', (e) => resolve({ ok: false, error: 'erro lendo a resposta pelo proxy: ' + e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `não deu para sair pelo proxy: ${e.message} (confira host, porta, usuário e senha)` }));
  });
}

/* ------------------------------------ medidor de tráfego ------------------------------------ */

interface HostCounter {
  bytes: number;
  requests: number;
}
interface PartitionTraffic {
  since: number;
  hosts: Map<string, HostCounter>;
}

const traffic = new Map<string, PartitionTraffic>();
const metered = new Set<string>();

function contentLength(headers: Record<string, string[] | string> | undefined): number {
  if (!headers) return 0;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== 'content-length') continue;
    const v = headers[k];
    const n = parseInt(Array.isArray(v) ? v[0] : v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Conta bytes de resposta HTTP por host (aproximado: content-length, ignorando o que veio do cache).
 * Não enxerga o WebSocket do jogo; esse o cliente sem tela mede sozinho.
 *
 * ATENÇÃO — fica DESLIGADO quando o proxy exige senha. Qualquer listener de `session.webRequest` faz o
 * Electron interceptar também os WebSockets da sessão (ElectronBrowserClient::WillInterceptWebSocket →
 * WebRequest::HasListener). Nesse caminho, quando o proxy responde 407 ao handshake do WebSocket,
 * ProxyingWebSocket::OnHeadersReceivedCompleteForAuth chama OnAuthRequiredComplete(kIoPending) → NOTREACHED()
 * e o PROCESSO PRINCIPAL morre: o app fecha sozinho, sem nada no nosso log (WER: 0x80000003 em
 * "Habblet AddAll.exe"+0x35c07a). Visto em 17/09/2026 no Electron 35.7.5: seis quedas seguidas, sempre
 * ~2 s depois de uma conta da Multidão chegar ao hotel com proxy autenticado (a primeira conta só passava
 * quando o site inteiro tinha ido pelo proxy antes e as credenciais já estavam no cache de autenticação).
 * Sem listener, o 407 do WebSocket segue pelo observador de rede normal e cai no evento `login` do app,
 * que responde com as credenciais. Nunca instalar outro listener de webRequest numa sessão com proxy
 * autenticado sem antes checar se o Electron corrigiu isso.
 */
function setTrafficMeter(partition: string, ses: Session, enabled: boolean): void {
  if (!traffic.has(partition)) traffic.set(partition, { since: Date.now(), hosts: new Map() });
  if (!enabled) {
    if (metered.delete(partition)) ses.webRequest.onCompleted(null);
    return;
  }
  if (metered.has(partition)) return;
  metered.add(partition);
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    if (details.fromCache) return;
    let host: string;
    try {
      host = new URL(details.url).hostname;
    } catch {
      return;
    }
    const t = traffic.get(partition) ?? { since: Date.now(), hosts: new Map<string, HostCounter>() };
    traffic.set(partition, t);
    const c = t.hosts.get(host) ?? { bytes: 0, requests: 0 };
    c.bytes += contentLength(details.responseHeaders as Record<string, string[]> | undefined);
    c.requests++;
    t.hosts.set(host, c);
  });
}

export interface PartitionTrafficReport {
  since: number;
  /** false = medidor HTTP desligado nesta partition (proxy com senha). */
  metered: boolean;
  bytesViaProxy: number;
  bytesDirect: number;
  requests: number;
  hosts: TrafficHostStat[];
}

export function trafficFor(partition: string): PartitionTrafficReport {
  const t = traffic.get(partition);
  const rules = scopeByPartition.get(partition);
  const hosts: TrafficHostStat[] = [];
  let viaProxy = 0;
  let direct = 0;
  let requests = 0;
  if (t) {
    for (const [host, c] of t.hosts) {
      const proxied = rules?.scope === 'all' ? true : rules?.scope === 'game-only' ? isGameHost(host, rules.gameHosts) : false;
      hosts.push({ host, bytes: c.bytes, requests: c.requests, viaProxy: proxied });
      if (proxied) viaProxy += c.bytes;
      else direct += c.bytes;
      requests += c.requests;
    }
  }
  hosts.sort((a, b) => b.bytes - a.bytes);
  // Partition que nunca passou por applyProxy não tem medidor "desligado": só avisa quando a conta já conectou.
  const isMetered = metered.has(partition) || !t;
  return { since: t?.since ?? Date.now(), metered: isMetered, bytesViaProxy: viaProxy, bytesDirect: direct, requests, hosts: hosts.slice(0, 12) };
}

export function resetTraffic(): void {
  for (const [k] of traffic) traffic.set(k, { since: Date.now(), hosts: new Map() });
}
