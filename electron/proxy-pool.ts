/**
 * Pool de proxies da Multidão: leitura de uma lista colada e chave de deduplicação. Puro (sem `electron`),
 * testado em tests/proxyPool.test.ts.
 *
 * O pool existe para separar "que proxies eu tenho" de "que conta usa qual": a lista é colada de uma vez
 * (um por linha, com ou sem esquema, ou o trecho de curl do provedor) e cada conta escolhe um item no
 * seletor da linha dela. O resultado de cada uso (site aceitou o login, anti-VPN recusou…) fica gravado
 * no item, então proxies ruins são vistos uma vez só.
 */
import { agentUrl, parseProxy } from './proxy-url';

export interface ParsedPoolLine {
  /** URL normalizada (com esquema e credenciais escapadas), como o pool guarda. */
  url: string;
  /** Chave de dedupe: esquema, usuário, host e porta (a senha não entra: é a mesma identidade). */
  key: string;
  /** `host:porta`, para mostrar sem credenciais. */
  display: string;
}

export interface ParsedPool {
  entries: ParsedPoolLine[];
  /** Linhas que não formam um proxy (com o motivo). */
  invalid: { line: string; error: string }[];
  /** Linhas repetidas dentro do próprio texto. */
  duplicates: number;
}

/** Identidade do proxy sem a senha, para não cadastrar o mesmo duas vezes. */
export function proxyKey(url: string): string {
  const p = parseProxy(url);
  return `${p.scheme}://${p.username ? encodeURIComponent(p.username) + '@' : ''}${p.host.toLowerCase()}:${p.port}`;
}

/** Ecoa só o que não é segredo (uma linha inválida pode carregar uma senha). */
function safeLine(line: string): string {
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

/**
 * Lê o texto colado: uma entrada por linha; linhas vazias e começadas por `#` são ignoradas. Uma linha
 * sem esquema (`user:pass@host:porta`, o formato que os provedores exportam) vira `http://`, igual ao campo
 * de proxy por conta. Repetidas dentro do texto ficam uma vez só.
 */
export function parseProxyPoolText(text: string): ParsedPool {
  const entries: ParsedPoolLine[] = [];
  const invalid: ParsedPool['invalid'] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const p = parseProxy(line);
      const key = proxyKey(line);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      entries.push({ url: agentUrl(p), key, display: `${p.host}:${p.port}` });
    } catch (e) {
      invalid.push({ line: safeLine(line.includes('@') ? line.replace(/^([a-z0-9]+:\/\/)?[^@]*@/i, '$1***@') : line), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { entries, invalid, duplicates };
}
