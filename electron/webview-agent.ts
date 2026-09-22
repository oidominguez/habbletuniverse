/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AGENTE DE PROTOCOLO — roda no "main world" da página do jogo, antes de qualquer
 * script do cliente Nitro.
 *
 * É injetado pelo preload do webview via `webFrame.executeJavaScript('(' + fn.toString() + ')()')`,
 * por isso esta função precisa ser 100% autocontida: nada de imports, nada de referências
 * a símbolos de fora, nada que o TypeScript precise "ajudar" com helpers (target ES2020).
 *
 * O que faz:
 *  - substitui `window.WebSocket` por um wrapper que observa cada conexão;
 *  - intercepta `send` (saída) e o evento `message` (entrada), separa os frames em pacotes
 *    `int32 length + int16 header + corpo` e envia lotes ao preload via `window.postMessage`;
 *  - recebe comandos (pausar, sondar, enviar pacote / bytes crus) também via postMessage;
 *  - sonda globais conhecidos do Nitro para descobrir o que o cliente expõe.
 */
export function habbletWebviewAgent(): void {
  const w = window as any;
  if (w.__HAB_AGENT__) return;

  // Corpo máximo guardado por pacote (bytes). 374/1778 chegam a 32 KB+; a lista de amigos (3130) de uma
  // conta com ~6 mil amigos passou de 337 KB em 17/09/2026 e era cortada em 256 KB, o que deixava a lista
  // incompleta e derrubava a decodificação. Acima disto o pacote vai marcado como `truncated`.
  const MAX_BODY = 4 * 1024 * 1024;
  const FLUSH_MS = 50;
  const FLUSH_MAX = 200;

  let seq = 0;
  let socketSeq = 0;
  let paused = false;
  let flushTimer: any = null;
  const queue: any[] = [];
  const sockets = new Set<WebSocket>();
  const socketIds = new WeakMap<WebSocket, number>();
  let lastSocket: WebSocket | null = null;

  // Modo sem tela: em vez de conectar, `new WebSocket` devolve um socket falso que captura o handshake.
  // Armado pelo comando `intercept` ou, para valer desde o primeiro socket da página, por uma chave em
  // sessionStorage gravada pelo app antes de abrir o /hotel (sobrevive a reload; mesma origem).
  const INTERCEPT_KEY = '__hab_intercept';
  let intercept = false;
  try {
    intercept = sessionStorage.getItem(INTERCEPT_KEY) === '1';
  } catch {
    /* sem storage */
  }

  /* ------------------------------ transporte para o preload ------------------------------ */

  function post(type: string, payload: any) {
    try {
      window.postMessage({ __hab: true, type: type, payload: payload }, '*');
    } catch {
      /* ignore */
    }
  }

  function flush() {
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    post('packets', batch);
  }

  function enqueue(rec: any) {
    queue.push(rec);
    if (queue.length >= FLUSH_MAX) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  /* ------------------------------ utilidades de bytes ------------------------------ */

  function toBase64(u8: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(i, i + 0x8000)));
    }
    return btoa(s);
  }

  function fromBase64(b64: string): Uint8Array {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function utf8ToBase64(text: string): string {
    return btoa(unescape(encodeURIComponent(text)));
  }

  /* ------------------------------ parsing de frames ------------------------------ */

  function parseFrame(u8: Uint8Array, dir: 'in' | 'out', socketId: number, injected: boolean) {
    const t = Date.now();
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0;
    while (off + 4 <= u8.length) {
      const len = dv.getInt32(off);
      if (len < 2 || off + 4 + len > u8.length) break;
      const header = dv.getInt16(off + 4);
      const body = u8.subarray(off + 6, off + 4 + len);
      // 2419 = SSO ticket, 2490 = machine id: nunca gravar o conteúdo.
      const sensitive = dir === 'out' && (header === 2419 || header === 2490);
      const rec: any = {
        id: ++seq,
        t: t,
        dir: dir,
        socketId: socketId,
        header: header,
        length: len,
        bodyLength: body.length,
        body: sensitive ? '' : toBase64(body.subarray(0, MAX_BODY)),
        truncated: !sensitive && body.length > MAX_BODY,
      };
      if (sensitive) rec.redacted = true;
      if (injected) rec.injected = true;
      enqueue(rec);
      off += 4 + len;
    }
    if (off < u8.length) {
      // Sobrou algo que não fecha um frame válido: framing diferente ou tráfego criptografado.
      const rest = u8.subarray(off);
      enqueue({
        id: ++seq,
        t: t,
        dir: dir,
        socketId: socketId,
        header: -1,
        length: rest.length,
        bodyLength: rest.length,
        body: toBase64(rest.subarray(0, MAX_BODY)),
        truncated: rest.length > MAX_BODY,
        raw: true,
      });
    }
  }

  function capture(data: any, dir: 'in' | 'out', socketId: number, injected: boolean) {
    if (paused) return;
    try {
      if (data instanceof ArrayBuffer) {
        parseFrame(new Uint8Array(data), dir, socketId, injected);
      } else if (ArrayBuffer.isView(data)) {
        parseFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), dir, socketId, injected);
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data.arrayBuffer().then(function (b) {
          parseFrame(new Uint8Array(b), dir, socketId, injected);
        });
      } else if (typeof data === 'string') {
        enqueue({
          id: ++seq,
          t: Date.now(),
          dir: dir,
          socketId: socketId,
          header: -2,
          length: data.length,
          bodyLength: data.length,
          body: utf8ToBase64(data.slice(0, MAX_BODY)),
          truncated: data.length > MAX_BODY,
          raw: true,
        });
      }
    } catch (e: any) {
      post('error', { message: 'capture: ' + (e && e.message ? e.message : String(e)), t: Date.now() });
    }
  }

  /* ------------------------------ hook do WebSocket ------------------------------ */

  const NativeWS: typeof WebSocket = w.WebSocket;
  const nativeSend = NativeWS.prototype.send;

  /**
   * Socket falso do modo sem tela. Parece um WebSocket para o cliente Nitro (readyState, eventos,
   * send/close), "abre" sozinho, guarda tudo que o cliente manda e entrega ao app como `handshake`
   * (4096 versão, 2490 machine id, 2419 ticket). Depois fica aberto e mudo: o cliente espera para sempre
   * e o app destrói a página assim que o cliente headless estiver conectado.
   */
  function createFakeSocket(url: string | URL): WebSocket {
    const sid = ++socketSeq;
    const listeners: Record<string, Array<(e: any) => void>> = {};
    const collected: any[] = [];
    let posted = false;
    let postTimer: any = null;
    const fake: any = {
      url: String(url),
      readyState: 0,
      protocol: '',
      extensions: '',
      binaryType: 'arraybuffer',
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
      addEventListener: function (type: string, fn: any) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      removeEventListener: function (type: string, fn: any) {
        const arr = listeners[type];
        if (arr) listeners[type] = arr.filter(function (f) { return f !== fn; });
      },
      dispatchEvent: function (ev: any) {
        const arr = listeners[ev.type] || [];
        for (let i = 0; i < arr.length; i++) {
          try { arr[i].call(fake, ev); } catch { /* ignore */ }
        }
        const handler = fake['on' + ev.type];
        if (typeof handler === 'function') {
          try { handler.call(fake, ev); } catch { /* ignore */ }
        }
        return true;
      },
      send: function (data: any) {
        if (fake.readyState !== 1) throw new Error('InvalidStateError: socket not open');
        let u8: Uint8Array | null = null;
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (!u8) return;
        // Corpo completo (sem redação) para o app reproduzir o handshake; a captura normal continua redigida.
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let off = 0;
        while (off + 4 <= u8.length) {
          const len = dv.getInt32(off);
          if (len < 2 || off + 4 + len > u8.length) break;
          collected.push({ header: dv.getInt16(off + 4), bodyBase64: toBase64(u8.subarray(off + 6, off + 4 + len)) });
          off += 4 + len;
        }
        capture(u8, 'out', sid, false);
        if (!posted) {
          if (postTimer) clearTimeout(postTimer);
          postTimer = setTimeout(function () {
            posted = true;
            post('handshake', {
              t: Date.now(),
              url: String(url),
              origin: location.origin,
              userAgent: navigator.userAgent,
              packets: collected.slice(),
            });
          }, 250);
        }
      },
      close: function (code?: number, reason?: string) {
        if (fake.readyState === 3) return;
        fake.readyState = 3;
        const ev: any = new Event('close');
        ev.code = code || 1000;
        ev.reason = reason || '';
        ev.wasClean = true;
        fake.dispatchEvent(ev);
      },
    };
    post('socket', { event: 'intercepted', socketId: sid, url: String(url), t: Date.now() });
    setTimeout(function () {
      if (fake.readyState !== 0) return;
      fake.readyState = 1;
      fake.dispatchEvent(new Event('open'));
    }, 30);
    return fake as WebSocket;
  }

  function HookedWebSocket(this: any, url: string | URL, protocols?: string | string[]): WebSocket {
    if (intercept) return createFakeSocket(url);
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    const sid = ++socketSeq;
    socketIds.set(ws, sid);
    sockets.add(ws);
    lastSocket = ws;
    post('socket', { event: 'open-attempt', socketId: sid, url: String(url), t: Date.now() });
    ws.addEventListener('open', function () {
      lastSocket = ws;
      post('socket', { event: 'open', socketId: sid, url: String(url), t: Date.now() });
    });
    ws.addEventListener('close', function (e: any) {
      sockets.delete(ws);
      if (lastSocket === ws) lastSocket = null;
      post('socket', { event: 'close', socketId: sid, code: e.code, reason: e.reason, t: Date.now() });
    });
    ws.addEventListener('error', function () {
      post('socket', { event: 'error', socketId: sid, url: String(url), t: Date.now() });
    });
    ws.addEventListener('message', function (e: any) {
      capture(e.data, 'in', sid, false);
    });
    return ws;
  }
  HookedWebSocket.prototype = NativeWS.prototype;
  (HookedWebSocket as any).CONNECTING = NativeWS.CONNECTING;
  (HookedWebSocket as any).OPEN = NativeWS.OPEN;
  (HookedWebSocket as any).CLOSING = NativeWS.CLOSING;
  (HookedWebSocket as any).CLOSED = NativeWS.CLOSED;

  NativeWS.prototype.send = function (this: WebSocket, data: any) {
    const sid = socketIds.get(this) || 0;
    capture(data, 'out', sid, false);
    return nativeSend.call(this, data);
  };

  w.WebSocket = HookedWebSocket;

  /* ------------------------------ envio pelo app ------------------------------ */

  function activeSocket(): WebSocket | null {
    if (lastSocket && lastSocket.readyState === NativeWS.OPEN) return lastSocket;
    let found: WebSocket | null = null;
    sockets.forEach(function (s) {
      if (s.readyState === NativeWS.OPEN) found = s;
    });
    return found;
  }

  function buildPacket(header: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + 2 + body.length);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, 2 + body.length);
    dv.setInt16(4, header);
    out.set(body, 6);
    return out;
  }

  function sendBytes(bytes: Uint8Array): boolean {
    const ws = activeSocket();
    if (!ws) {
      post('error', { message: 'Nenhuma conexão WebSocket aberta para enviar.', t: Date.now() });
      return false;
    }
    nativeSend.call(ws, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    capture(bytes, 'out', socketIds.get(ws) || 0, true);
    return true;
  }

  /* ------------------------------ sondagem dos internos ------------------------------ */

  function probe() {
    const names = [
      'Nitro',
      'NitroInstance',
      'NitroConfig',
      'NitroCore',
      'NitroRenderer',
      'nitro',
      'GetNitroInstance',
      'GetConfiguration',
      'PIXI',
      'React',
      'ReactDOM',
      '__REACT_DEVTOOLS_GLOBAL_HOOK__',
      'webpackChunk',
      'webpackJsonp',
      '__vite__',
    ];
    const found: Record<string, string> = {};
    for (let i = 0; i < names.length; i++) {
      try {
        if (names[i] in w) found[names[i]] = typeof w[names[i]];
      } catch {
        /* ignore */
      }
    }
    // Chunks webpack costumam aparecer como window.webpackChunk<nome>
    try {
      Object.keys(w).forEach(function (k) {
        if (/^webpackChunk/i.test(k) && !(k in found)) found[k] = typeof w[k];
      });
    } catch {
      /* ignore */
    }
    let socketUrl: string | null = null;
    let nitroConfigKeys: string[] | undefined;
    try {
      const cfg = w.NitroConfig;
      if (cfg && typeof cfg === 'object') {
        nitroConfigKeys = Object.keys(cfg).slice(0, 200);
        socketUrl = cfg['socket.url'] || (cfg.socket && cfg.socket.url) || null;
      }
    } catch {
      /* ignore */
    }
    if (!socketUrl) {
      sockets.forEach(function (s) {
        if (!socketUrl) socketUrl = s.url;
      });
    }
    post('probe', {
      t: Date.now(),
      href: location.href,
      found: found,
      socketUrl: socketUrl,
      openSockets: sockets.size,
      nitroConfigKeys: nitroConfigKeys,
    });
  }

  /* ------------------------------ comandos do app ------------------------------ */

  window.addEventListener('message', function (e: MessageEvent) {
    const d: any = e.data;
    if (!d || d.__habCmd !== true || !d.cmd) return;
    const cmd = d.cmd;
    try {
      if (cmd.type === 'pause') paused = true;
      else if (cmd.type === 'resume') paused = false;
      else if (cmd.type === 'probe') probe();
      else if (cmd.type === 'intercept') {
        intercept = cmd.enabled !== false;
        try {
          if (intercept) sessionStorage.setItem(INTERCEPT_KEY, '1');
          else sessionStorage.removeItem(INTERCEPT_KEY);
        } catch {
          /* sem storage */
        }
      }
      else if (cmd.type === 'send') sendBytes(buildPacket(cmd.header | 0, fromBase64(cmd.bodyBase64 || '')));
      else if (cmd.type === 'sendRaw') sendBytes(fromBase64(cmd.base64 || ''));
    } catch (err: any) {
      post('error', { message: 'cmd ' + cmd.type + ': ' + (err && err.message ? err.message : String(err)), t: Date.now() });
    }
  });

  w.__HAB_AGENT__ = { version: 2, probe: probe };
  post('ready', { t: Date.now(), href: location.href, intercepting: intercept });
  window.addEventListener('load', function () {
    setTimeout(probe, 1500);
    setTimeout(probe, 6000);
  });
}
