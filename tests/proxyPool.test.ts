import { describe, expect, it } from 'vitest';
import { parseProxyPoolText, proxyKey } from '../electron/proxy-pool';

describe('parseProxyPoolText', () => {
  it('lê o formato dos provedores (user:pass@host:porta, sem esquema) como http e guarda a URL normalizada', () => {
    const r = parseProxyPoolText('brd-customer-hl_abc-zone-isp_proxy3-ip-200.239.198.81:5c9pslic57sc@brd.superproxy.io:44445');
    expect(r.invalid).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].url).toBe('http://brd-customer-hl_abc-zone-isp_proxy3-ip-200.239.198.81:5c9pslic57sc@brd.superproxy.io:44445');
    expect(r.entries[0].display).toBe('brd.superproxy.io:44445');
    expect(r.entries[0].key).toBe('http://brd-customer-hl_abc-zone-isp_proxy3-ip-200.239.198.81@brd.superproxy.io:44445');
  });

  it('ignora linhas vazias e comentários, aceita esquemas explícitos e o trecho de curl', () => {
    const r = parseProxyPoolText(['', '# lista do dia', 'socks5://u:p@1.2.3.4:1080', 'curl -x "http://h.example:7878" -U "user:pw" https://ip', '   '].join('\n'));
    expect(r.entries.map((e) => e.url)).toEqual(['socks5://u:p@1.2.3.4:1080', 'http://user:pw@h.example:7878']);
    expect(r.invalid).toEqual([]);
    expect(r.duplicates).toBe(0);
  });

  it('deduplica pela identidade (esquema, usuário, host, porta), mesmo com senha diferente ou esquema implícito', () => {
    const r = parseProxyPoolText(['user:pw1@h.example:8080', 'http://user:pw2@h.example:8080', 'user:pw1@H.EXAMPLE:8080', 'other:pw@h.example:8080'].join('\n'));
    expect(r.entries).toHaveLength(2);
    expect(r.duplicates).toBe(2);
    expect(r.entries.map((e) => e.key)).toEqual(['http://user@h.example:8080', 'http://other@h.example:8080']);
  });

  it('reporta linhas inválidas sem ecoar a senha', () => {
    const r = parseProxyPoolText(['isso não é proxy', 'user:segredo@', 'ftp://user:segredo@h.example:21'].join('\n'));
    expect(r.entries).toEqual([]);
    expect(r.invalid).toHaveLength(3);
    expect(r.invalid[0].line).toBe('isso não é proxy');
    expect(r.invalid[1].line).toBe('***@');
    expect(r.invalid[2].line).toBe('ftp://***@h.example:21');
    for (const inv of r.invalid) expect(inv.line).not.toContain('segredo');
    expect(r.invalid[2].error).toMatch(/não suportado/);
  });

  it('proxyKey casa a mesma identidade escrita de formas diferentes', () => {
    expect(proxyKey('user:pw@h.example:8080')).toBe(proxyKey('http://user:x@H.example:8080'));
    expect(proxyKey('socks5://h.example:1080')).toBe('socks5://h.example:1080');
  });
});
