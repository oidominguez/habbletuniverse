/**
 * URL de proxy → partes, e as regras de roteamento (PAC / hosts do jogo). Puro: sem `electron`, testável.
 *
 * Esquemas aceitos: http, https, socks5, socks5h (SOCKS5 resolvendo DNS no proxy — formato dos provedores
 * e do curl; para o Chromium e o `ws` é o mesmo SOCKS5), socks4, socks4a, socks (= socks5).
 */
export interface ParsedProxy {
  scheme: 'http' | 'https' | 'socks5' | 'socks4';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const SCHEMES: Record<string, ParsedProxy['scheme']> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
  socks4: 'socks4',
  socks4a: 'socks4',
};

const INVALID = 'URL do proxy inválida: use http://usuario:senha@host:porta (ou socks5://…).';

/**
 * Aceita também o trecho de comando curl que os provedores mostram como exemplo:
 *   curl -x "http://host:7878" -U "usuario:senha" https://ip…   |   -x host:porta --proxy-user usuario:senha
 * Extrai a URL e as credenciais. Colado sem ajuste (17/09/2026), isso virava host inválido e a senha
 * acabava no log pela descrição de fallback.
 */
function normalizeProxyInput(raw: string): string {
  // Só entra aqui com cara de curl (aspas ou opções -x/-U/--proxy); senha com espaço numa URL normal passa direto.
  if (!/["']|(^|\s)(-x|-U|--proxy|--proxy-user)(=|\s)/.test(raw)) return raw;
  const tokens = raw.replace(/["']/g, ' ').split(/\s+/).filter(Boolean);
  let url: string | undefined;
  let user: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-U' || t === '--proxy-user') user = tokens[++i];
    else if (t.startsWith('--proxy-user=')) user = t.slice('--proxy-user='.length);
    else if (t === '-x' || t === '--proxy') url = tokens[++i];
    else if (t.startsWith('--proxy=')) url = t.slice('--proxy='.length);
    else if (!url && /^([a-z0-9]+:\/\/)?[^\s/]+:\d+$/i.test(t)) url = t;
  }
  if (!url) throw new Error(INVALID);
  if (user && !url.includes('@')) {
    const sep = user.indexOf(':');
    const u = sep < 0 ? user : user.slice(0, sep);
    const p = sep < 0 ? '' : user.slice(sep + 1);
    const m = /^([a-z0-9]+:\/\/)?(.*)$/i.exec(url);
    url = `${m?.[1] ?? ''}${encodeURIComponent(u)}:${encodeURIComponent(p)}@${m?.[2] ?? url}`;
  }
  return url;
}

export function parseProxy(url: string): ParsedProxy {
  const raw = normalizeProxyInput(url.trim());
  // aceita "host:port", "user:pass@host:port" e URLs completas
  const withScheme = /^[a-z0-9]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(INVALID);
  }
  const scheme = SCHEMES[u.protocol.replace(':', '').toLowerCase()];
  if (!scheme) throw new Error(`Esquema de proxy não suportado: ${u.protocol.replace(':', '')} (use http, https, socks5, socks5h ou socks4)`);
  // A URL WHATWG omite a porta padrão do esquema (http://h:80 → port ""): repõe.
  const defaultPort = u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : NaN;
  const port = u.port ? parseInt(u.port, 10) : defaultPort;
  if (!u.hostname || !port) throw new Error('Proxy precisa de host e porta (ex.: socks5://user:pass@host:1080).');
  return {
    scheme,
    host: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** Descrição sem credenciais, para exibir na interface e no log. Nunca ecoa a entrada bruta (pode ter senha). */
export function describeProxy(url: string): string {
  try {
    const p = parseProxy(url);
    return `${p.scheme}://${p.host}:${p.port}${p.username ? ' (auth)' : ''}`;
  } catch {
    // Com user:pass@ dá para mascarar; qualquer outra coisa não é ecoada (pode carregar a senha solta).
    return !/\s/.test(url) && url.includes('@') ? url.replace(/\/\/[^@]*@/, '//***@') : '(proxy inválido)';
  }
}

/** Diretiva no formato do PAC/Chromium ("SOCKS5 host:port", "PROXY host:port"…). */
export function pacDirective(p: ParsedProxy): string {
  if (p.scheme === 'socks5') return `SOCKS5 ${p.host}:${p.port}`;
  if (p.scheme === 'socks4') return `SOCKS ${p.host}:${p.port}`;
  if (p.scheme === 'https') return `HTTPS ${p.host}:${p.port}`;
  return `PROXY ${p.host}:${p.port}`;
}

/** true se `host` é um dos hosts do jogo ou subdomínio deles. */
export function isGameHost(host: string, gameHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return gameHosts.some((g) => {
    const gg = g.trim().toLowerCase();
    return gg !== '' && (h === gg || h.endsWith('.' + gg));
  });
}

/** PAC: só os hosts do jogo saem pelo proxy; tudo o mais vai direto. */
export function buildPac(directive: string, gameHosts: readonly string[]): string {
  const hosts = JSON.stringify(gameHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  return `function FindProxyForURL(url, host) {
  var hosts = ${hosts};
  host = host.toLowerCase();
  for (var i = 0; i < hosts.length; i++) {
    if (host === hosts[i] || dnsDomainIs(host, '.' + hosts[i])) return ${JSON.stringify(directive)};
  }
  return 'DIRECT';
}`;
}

/**
 * Sessão fixa por conta nos provedores residenciais rotativos. Sem ela, cada requisição sai por um IP
 * diferente e o Habblet derruba a sessão do site no meio do login e recusa o ticket do jogo ("Bye" logo
 * após o handshake, visto em 17/09/2026 com a Bright Data rotativa). O identificador vai no usuário do
 * proxy, no formato de cada provedor, só quando o usuário ainda não traz um:
 *   Bright Data  brd.superproxy.io      brd-customer-X-zone-Y  → …-session-<id>
 *   Decodo       gate.decodo.com etc.   user-X                 → …-session-<id>  (residencial; o ISP por porta já é fixo)
 *   Oxylabs      pr.oxylabs.io          customer-X             → …-sessid-<id>
 *   IPRoyal      geo.iproyal.com        X                      → X_session-<id>
 * `sessionId` deve ser estável por conta (usamos o início do id da conta) e só letras/dígitos.
 */
export function withStickySession(url: string, sessionId: string): string {
  const sid = sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  if (!sid) return url;
  let p: ParsedProxy;
  try {
    p = parseProxy(url);
  } catch {
    return url;
  }
  if (!p.username) return url;
  const host = p.host.toLowerCase();
  const u = p.username;
  let next: string | null = null;
  if (host.endsWith('superproxy.io')) {
    if (!/-session-/.test(u)) next = `${u}-session-${sid}`;
  } else if (host.endsWith('decodo.com') || host.endsWith('smartproxy.com')) {
    if (/^user-/.test(u) && !/-session-/.test(u) && !host.startsWith('isp.') && !host.startsWith('dc.')) next = `${u}-session-${sid}`;
  } else if (host.endsWith('oxylabs.io')) {
    if (/^customer-/.test(u) && !/-sessid-/.test(u)) next = `${u}-sessid-${sid}`;
  } else if (host.endsWith('iproyal.com')) {
    if (!/_session-/.test(u)) next = `${u}_session-${sid}`;
  }
  if (!next) return url;
  return agentUrl({ ...p, username: next });
}

/** URL para os agentes do `ws` (socks-proxy-agent / https-proxy-agent), com credenciais escapadas. */
export function agentUrl(p: ParsedProxy): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}
