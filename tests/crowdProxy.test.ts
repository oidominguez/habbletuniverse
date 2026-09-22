import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regressão da queda de 17/09/2026: com um listener de `session.webRequest` na partition, o Electron 35
 * intercepta os WebSockets e morre (NOTREACHED em ProxyingWebSocket) quando o proxy responde 407 ao
 * handshake do jogo. O medidor de tráfego, único listener do app, só pode existir sem senha no proxy.
 */
const fake = vi.hoisted(() => ({
  setProxy: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
  webRequest: { onCompleted: vi.fn() },
  fetch: vi.fn(),
  getUserAgent: () => 'ua',
}));

const fakeNet = vi.hoisted(() => {
  const requests: { url: string; loginAnswered: [string, string] | null }[] = [];
  const request = vi.fn((opts: { url: string }) => {
    const entry = { url: opts.url, loginAnswered: null as [string, string] | null };
    requests.push(entry);
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const req = {
      on(ev: string, cb: (...a: unknown[]) => void) {
        handlers[ev] = cb;
        return req;
      },
      abort() {},
      end() {
        // Simula o 407 do proxy e depois a resposta.
        handlers.login?.({ isProxy: true, host: 'proxy.example', port: 10001, scheme: 'basic' }, (u: string, p: string) => {
          entry.loginAnswered = [u, p];
        });
        const res = {
          statusCode: 404,
          on(ev: string, cb: () => void) {
            if (ev === 'end') setTimeout(cb, 0);
            return res;
          },
        };
        handlers.response?.(res);
      },
    };
    return req;
  });
  return { request, requests };
});

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => undefined },
  net: { request: fakeNet.request },
  session: { fromPartition: vi.fn(() => fake) },
}));

import { applyProxy, trafficFor } from '../electron/crowd-proxy';
import { defaultCrowdNetworkSettings } from '../shared/crowd';

const meterFilter = { urls: ['<all_urls>'] };

describe('applyProxy × medidor de tráfego (listener de webRequest)', () => {
  beforeEach(() => {
    fake.webRequest.onCompleted.mockClear();
    fake.setProxy.mockClear();
  });

  it('partition que nunca conectou não aparece como sem medição', () => {
    expect(trafficFor('persist:crowd-nunca').metered).toBe(true);
  });

  it('sem proxy: instala o medidor e marca metered', async () => {
    const r = await applyProxy('persist:crowd-direto', null, defaultCrowdNetworkSettings);
    expect(r).toEqual({ rules: null, scope: 'direct' });
    expect(fake.webRequest.onCompleted).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onCompleted.mock.calls[0][0]).toEqual(meterFilter);
    expect(trafficFor('persist:crowd-direto').metered).toBe(true);
  });

  it('proxy sem senha: mantém o medidor (não há 407 possível)', async () => {
    const r = await applyProxy('persist:crowd-anon', 'http://proxy.example:10001', defaultCrowdNetworkSettings);
    expect(r.scope).toBe('game-only');
    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onCompleted).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onCompleted.mock.calls[0][0]).toEqual(meterFilter);
    expect(trafficFor('persist:crowd-anon').metered).toBe(true);
  });

  it('proxy com senha: remove o listener ANTES do setProxy e marca metered=false', async () => {
    const partition = 'persist:crowd-auth';
    await applyProxy(partition, null, defaultCrowdNetworkSettings); // fase de login pelo IP real: medidor ligado
    expect(trafficFor(partition).metered).toBe(true);
    fake.webRequest.onCompleted.mockClear();

    const r = await applyProxy(partition, 'http://user:pass@proxy.example:10001', defaultCrowdNetworkSettings, ['game.habblet.city']);
    expect(r).toEqual({ rules: 'http://proxy.example:10001', scope: 'game-only' });
    expect(fake.webRequest.onCompleted).toHaveBeenCalledTimes(1);
    expect(fake.webRequest.onCompleted).toHaveBeenCalledWith(null);
    expect(fake.webRequest.onCompleted.mock.invocationCallOrder[0]).toBeLessThan(fake.setProxy.mock.invocationCallOrder[0]);
    expect(trafficFor(partition).metered).toBe(false);
    // Aquecimento do cache de autenticação: uma requisição pelo host do jogo, respondendo o 407 com as credenciais.
    const warm = fakeNet.requests.at(-1);
    expect(warm?.url).toBe('https://game.habblet.city/');
    expect(warm?.loginAnswered).toEqual(['user', 'pass']);
  });

  it('proxy sem senha não aquece nada (não há 407)', async () => {
    const before = fakeNet.requests.length;
    await applyProxy('persist:crowd-anon2', 'http://proxy.example:10001', defaultCrowdNetworkSettings);
    expect(fakeNet.requests.length).toBe(before);
  });

  it('proxy com senha numa partition que nunca teve medidor: não mexe no webRequest', async () => {
    await applyProxy('persist:crowd-auth2', 'socks5://u:p@1.2.3.4:1080', defaultCrowdNetworkSettings);
    expect(fake.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(trafficFor('persist:crowd-auth2').metered).toBe(false);
  });
});
