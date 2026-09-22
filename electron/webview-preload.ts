import { ipcRenderer, webFrame } from 'electron';
import { habbletWebviewAgent } from './webview-agent';

/**
 * PRELOAD DO <webview> — roda no "isolated world" da página do jogo, antes dos scripts dela.
 *
 * Papel: ser o carteiro entre o agente (main world) e a interface do app (renderer).
 *  - injeta o agente no main world, onde ele consegue substituir o WebSocket do cliente;
 *  - repassa mensagens do agente (window.postMessage) para o renderer (ipcRenderer.sendToHost);
 *  - repassa comandos do renderer (webview.send) para o agente (window.postMessage).
 *
 * Os dois "worlds" compartilham o DOM e os eventos, mas não os globais JS, por isso o
 * postMessage funciona como ponte e a página do jogo nunca enxerga o ipcRenderer.
 */
const PROTO_CHANNEL = 'hab:proto';
const CMD_CHANNEL = 'hab:cmd';
const RECORD_CHANNEL = 'hab:proto:record';
const CF_CHANNEL = 'hab:cf';

/**
 * Hook do Cloudflare Turnstile (main world). A página de desafio ("Confirme que é humano") e o
 * widget explícito chamam `turnstile.render(el, opts)`; capturamos sitekey/action/cData/chlPageData
 * e guardamos o `callback` em `window.__habCfSolve(token)` para entregar um token resolvido fora.
 * O render original continua acontecendo, então o caminho manual (clicar na caixa) segue válido.
 */
const cfHookSource = `(function(){
  if (window.__habCfHooked) return; window.__habCfHooked = true;
  var hook = function(){
    var ts = window.turnstile;
    if (!ts || ts.__habHooked) return !!ts;
    var orig = ts.render;
    ts.__habHooked = true;
    ts.render = function(el, opts){
      try {
        opts = opts || {};
        window.__habCfSolve = function(token){ if (typeof opts.callback === 'function') { opts.callback(token); return true; } return false; };
        window.postMessage({ __habCf: true, params: {
          url: location.href, sitekey: opts.sitekey, action: opts.action, cdata: opts.cData,
          pagedata: opts.chlPageData, userAgent: navigator.userAgent, challenge: !!opts.chlPageData
        } }, '*');
      } catch (e) {}
      return orig ? orig.apply(this, arguments) : undefined;
    };
    return true;
  };
  var n = 0; var t = setInterval(function(){ if (hook() || ++n > 3000) clearInterval(t); }, 10);
})();`;
if (!process.env.HABBLET_NO_CFHOOK) webFrame.executeJavaScript(cfHookSource).catch(() => undefined);

const agentSource = '(' + habbletWebviewAgent.toString() + ')();';
webFrame.executeJavaScript(agentSource).catch((e: unknown) => {
  ipcRenderer.sendToHost(PROTO_CHANNEL, {
    __hab: true,
    type: 'error',
    payload: { message: 'Falha ao injetar o agente: ' + String(e), t: Date.now() },
  });
});

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { __hab?: boolean; __habCf?: boolean; params?: unknown } | null;
  if (d && d.__habCf === true) {
    ipcRenderer.sendToHost(CF_CHANNEL, d.params);
    return;
  }
  if (!d || d.__hab !== true) return;
  ipcRenderer.sendToHost(PROTO_CHANNEL, d);
  // O handshake interceptado carrega o ticket SSO em claro: só para o renderer, nunca para o disco.
  if ((d as { type?: string }).type === 'handshake') return;
  // Cópia para o processo principal, que grava a sessão em disco (NDJSON).
  ipcRenderer.send(RECORD_CHANNEL, d);
});

ipcRenderer.on(CMD_CHANNEL, (_event, cmd: unknown) => {
  window.postMessage({ __habCmd: true, cmd }, '*');
});
