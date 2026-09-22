import { describe, expect, it } from 'vitest';
import { agentUrl, buildPac, describeProxy, isGameHost, pacDirective, parseProxy, withStickySession } from '../electron/proxy-url';

describe('withStickySession', () => {
  it('Bright Data: acrescenta -session-<id> ao usuário uma vez só', () => {
    const once = withStickySession('http://brd-customer-abc-zone-res:pw@brd.superproxy.io:33335', 'afa3f4b4');
    expect(once).toBe('http://brd-customer-abc-zone-res-session-afa3f4b4:pw@brd.superproxy.io:33335');
    expect(withStickySession(once, 'outro')).toBe(once);
    expect(parseProxy(once).password).toBe('pw');
  });
  it('Decodo residencial e Oxylabs no formato de cada um; ISP por porta e host desconhecido ficam como estão', () => {
    expect(withStickySession('http://user-joao:pw@gate.decodo.com:7000', 'a1b2')).toBe('http://user-joao-session-a1b2:pw@gate.decodo.com:7000');
    expect(withStickySession('http://user-joao:pw@isp.decodo.com:10001', 'a1b2')).toBe('http://user-joao:pw@isp.decodo.com:10001');
    expect(withStickySession('http://customer-joao:pw@pr.oxylabs.io:7777', 'a1b2')).toBe('http://customer-joao-sessid-a1b2:pw@pr.oxylabs.io:7777');
    expect(withStickySession('http://u:p@proxy.example:8080', 'a1b2')).toBe('http://u:p@proxy.example:8080');
    expect(withStickySession('http://brd.superproxy.io:33335', 'a1b2')).toBe('http://brd.superproxy.io:33335');
  });
});

describe('parseProxy', () => {
  it('aceita o trecho de curl dos provedores (-x URL -U user:pass) e nunca ecoa a senha na descrição', () => {
    const curl = 'http://us.proxy001.com:7878" -U "cjrvvm722494_custom_zone_BR_st_SaoPaulo:pwd374130';
    expect(parseProxy(curl)).toEqual({ scheme: 'http', host: 'us.proxy001.com', port: 7878, username: 'cjrvvm722494_custom_zone_BR_st_SaoPaulo', password: 'pwd374130' });
    expect(parseProxy('curl -x "socks5h://1.2.3.4:1080" --proxy-user "u:p" https://ip.decodo.com/json')).toMatchObject({ scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' });
    expect(describeProxy(curl)).toBe('http://us.proxy001.com:7878 (auth)');
    expect(describeProxy('isso não é um proxy')).toBe('(proxy inválido)');
    expect(() => parseProxy('http://host:80 lixo qualquer')).toThrow(/URL do proxy inválida/);
    expect(() => parseProxy('sem porta nem nada com espaço')).toThrow(/URL do proxy inválida/);
  });

  it('aceita socks5h e socks4a (formato dos provedores) como socks5 / socks4', () => {
    expect(parseProxy('socks5h://user:pass@1.2.3.4:1080')).toEqual({ scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' });
    expect(parseProxy('socks4a://h:9').scheme).toBe('socks4');
    expect(parseProxy('socks://h:9').scheme).toBe('socks5');
  });
  it('host:porta sem esquema vira http; credenciais são desescapadas', () => {
    expect(parseProxy('proxy.example:8080')).toMatchObject({ scheme: 'http', host: 'proxy.example', port: 8080 });
    expect(parseProxy('http://u%40x:p%23w@h:1')).toMatchObject({ username: 'u@x', password: 'p#w' });
  });
  it('rejeita esquema desconhecido e falta de porta', () => {
    expect(() => parseProxy('ftp://h:1')).toThrow(/não suportado/);
    expect(() => parseProxy('socks5://host')).toThrow(/porta/);
  });
});

describe('descrição, PAC e agente', () => {
  it('describeProxy esconde credenciais', () => {
    expect(describeProxy('socks5h://u:p@h:1080')).toBe('socks5://h:1080 (auth)');
    expect(describeProxy('lixo://u:p@h')).toBe('lixo://***@h');
  });
  it('pacDirective e buildPac roteiam só os hosts do jogo', () => {
    const pac = buildPac(pacDirective(parseProxy('socks5h://h:1080')), ['habblet.city', 'game.habblet.city']);
    expect(pac).toContain('"SOCKS5 h:1080"');
    expect(pac).toContain('["habblet.city","game.habblet.city"]');
    expect(pac).toContain("return 'DIRECT'");
    expect(pacDirective(parseProxy('https://h:443'))).toBe('HTTPS h:443');
  });
  it('isGameHost casa host exato e subdomínios', () => {
    expect(isGameHost('game.habblet.city', ['habblet.city'])).toBe(true);
    expect(isGameHost('habblet.city', ['habblet.city'])).toBe(true);
    expect(isGameHost('nothabblet.city', ['habblet.city'])).toBe(false);
  });
  it('agentUrl escapa credenciais para o socks-proxy-agent', () => {
    expect(agentUrl(parseProxy('socks5h://u@x:p w@h:1080'))).toBe('socks5://u%40x:p%20w@h:1080');
  });
});
