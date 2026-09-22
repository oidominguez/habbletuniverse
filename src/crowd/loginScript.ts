/**
 * Scripts executados na página do site (habblet.city) dentro do webview de uma conta,
 * via executeJavaScript. Todos devolvem uma promise com um objeto de resultado.
 *
 * Formulário observado em 13/09/2026: `form#form-login` (POST /account/login) com
 * input[name=username], input[name=password], input[name=cf-turnstile-response] (Cloudflare
 * Turnstile, preenchido pelo widget), campos ocultos _csrf e _asteroid, e button[type=submit].
 */

export interface LoginProbe {
  url: string;
  /** `document.readyState` da página ('loading' | 'interactive' | 'complete'). */
  readyState: string;
  hasForm: boolean;
  /** Os dois campos (usuário e senha) já existem no DOM. Em páginas lentas o formulário chega depois do "carregou". */
  hasInputs: boolean;
  /** O campo de usuário está preenchido (sobrou de uma tentativa nossa). */
  userFilled: boolean;
  /** Link/botão para o hotel presente (aparece também para visitantes; não prova login). */
  hasHotelLink: boolean;
  /** Link de sair / área da conta presente: sessão web autenticada. */
  hasLogout: boolean;
  /** Texto de erro exibido pelo site, se houver. */
  errorText: string | null;
  /** Página de desafio do Cloudflare ("Um momento…" / challenge) em vez do site. */
  cfChallenge: boolean;
}

export const LOGIN_FORM_SELECTOR = 'form#form-login, form[action*="/account/login"]';

export const PROBE_LOGIN_JS = `(function(){
  var form = document.querySelector(${JSON.stringify(LOGIN_FORM_SELECTOR)});
  var user = form ? form.querySelector('input[name="username"]') : document.querySelector('input[name="username"]');
  var pass = form ? form.querySelector('input[name="password"]') : document.querySelector('input[name="password"]');
  var hotel = document.querySelector('a[href*="/hotel"], a[href$="hotel"]');
  var logout = document.querySelector('a[href*="logout"], form[action*="logout"], a[href*="/account/settings"], a[href*="/me"], [class*="logout"]');
  var err = document.querySelector('.alert-danger, .error, .form-error, [class*="error"]');
  var cf = !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-browser-verification, #cf-chl-widget-1, [id^="cf-chl-widget"] iframe') && !form;
  var title = (document.title || '').toLowerCase();
  if (/just a moment|um momento|attention required|verifique/.test(title)) cf = true;
  return {
    url: location.href,
    readyState: document.readyState,
    hasForm: !!form,
    hasInputs: !!(user && pass),
    userFilled: !!(user && user.value),
    hasHotelLink: !!hotel,
    hasLogout: !!logout,
    errorText: err && err.textContent ? err.textContent.trim().slice(0, 200) : null,
    cfChallenge: cf
  };
})()`;

/**
 * Depois de um Turnstile que não liberou sozinho: verifica se o token apareceu (o usuário
 * resolveu o desafio na tela da conta) e, se sim, envia o formulário. Devolve `sent`.
 */
export const RESUME_LOGIN_JS = `(function(){
  var form = document.querySelector('form#form-login, form[action*="/account/login"]');
  if (!form) return { form: false, sent: false };
  var token = form.querySelector('input[name="cf-turnstile-response"]');
  var user = form.querySelector('input[name="username"]');
  if (token && !token.value) return { form: true, sent: false, hasUser: !!(user && user.value) };
  var btn = form.querySelector('button[type="submit"], .submit-form');
  if (btn) btn.click(); else if (form.requestSubmit) form.requestSubmit(); else form.submit();
  return { form: true, sent: true };
})()`;

export interface TurnstileInfo {
  hasForm: boolean;
  sitekey: string | null;
  action: string | null;
  cdata: string | null;
  url: string;
}

/** Lê os parâmetros do widget Turnstile na página de login (para pedir o token a um resolvedor). */
export const PROBE_TURNSTILE_JS = `(function(){
  var form = document.querySelector('form#form-login, form[action*="/account/login"]');
  var w = document.querySelector('.cf-turnstile, [data-sitekey]');
  var sitekey = w ? (w.getAttribute('data-sitekey') || null) : null;
  if (!sitekey) {
    // widget renderizado por script: procura a chave em qualquer atributo/parâmetro visível
    var m = document.documentElement.innerHTML.match(/0x[0-9A-Za-z_-]{20,}/);
    sitekey = m ? m[0] : null;
  }
  return {
    hasForm: !!form,
    sitekey: sitekey,
    action: w ? (w.getAttribute('data-action') || null) : null,
    cdata: w ? (w.getAttribute('data-cdata') || null) : null,
    url: location.href
  };
})()`;

/** Injeta o token resolvido no campo do Turnstile e envia o formulário. */
export function buildSubmitWithTokenJs(token: string): string {
  const t = JSON.stringify(token);
  return `(function(){
    var form = document.querySelector('form#form-login, form[action*="/account/login"]');
    if (!form) return { ok: false, step: 'no-form' };
    var input = form.querySelector('input[name="cf-turnstile-response"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = 'cf-turnstile-response'; form.appendChild(input); }
    input.value = ${t};
    var alt = form.querySelector('input[name="g-recaptcha-response"]');
    if (alt) alt.value = ${t};
    var btn = form.querySelector('button[type="submit"], .submit-form');
    if (btn) btn.click(); else if (form.requestSubmit) form.requestSubmit(); else form.submit();
    return { ok: true, step: 'submitted' };
  })()`;
}

export interface LoginAttemptResult {
  ok: boolean;
  step: 'no-form' | 'fields-timeout' | 'fill-failed' | 'filled' | 'submitted' | 'turnstile-timeout' | 'error';
  message?: string;
}

/** Quanto esperar os campos aparecerem numa página lenta antes de desistir desta tentativa. */
export const LOGIN_FIELDS_WAIT_MS = 20000;
/** Quanto esperar o Turnstile gerenciado preencher o token sozinho. */
export const LOGIN_TURNSTILE_WAIT_MS = 12000;

/**
 * Preenche usuário e senha, aceita o aviso de cookies se estiver na frente, espera o token do
 * Turnstile e envia o formulário. A navegação resultante é observada pelo `did-stop-loading`.
 *
 * Resistente a página lenta: espera os campos aparecerem (até `fieldsWaitMs`), preenche com o setter
 * nativo (funciona em campos controlados por React), confere que o valor "pegou" e, se não pegou,
 * tenta de novo digitando. Só então cuida do Turnstile e envia.
 */
export function buildLoginJs(username: string, password: string, fieldsWaitMs = LOGIN_FIELDS_WAIT_MS, turnstileWaitMs = LOGIN_TURNSTILE_WAIT_MS): string {
  const u = JSON.stringify(username);
  const p = JSON.stringify(password);
  return `(async function(){
    var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
    var FORM = ${JSON.stringify(LOGIN_FORM_SELECTOR)};
    var setVal = function(el, v){
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    var typeVal = function(el, v){
      // Plano B: digita como o usuário digitaria (alguns frameworks só reagem a isso).
      el.focus();
      try { el.select(); } catch (e) {}
      try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, v); } catch (e) {}
      if (el.value !== v) setVal(el, v);
    };
    var find = function(){
      var form = document.querySelector(FORM);
      var user = form ? form.querySelector('input[name="username"]') : null;
      var pass = form ? form.querySelector('input[name="password"]') : null;
      return { form: form, user: user, pass: pass };
    };
    // 1) espera o formulário e os campos existirem (página lenta / render tardio)
    var waited = 0, f = find();
    while ((!f.form || !f.user || !f.pass) && waited < ${fieldsWaitMs}) { await sleep(200); waited += 200; f = find(); }
    if (!f.form) return { ok: false, step: 'no-form', message: 'formulário não apareceu em ' + Math.round(waited / 1000) + ' s' };
    if (!f.user || !f.pass) return { ok: false, step: 'fields-timeout', message: 'campos de usuário/senha não apareceram em ' + Math.round(waited / 1000) + ' s' };
    var form = f.form, user = f.user, pass = f.pass;
    var cookieBtn = document.querySelector('#cookie-accept');
    if (cookieBtn) { try { cookieBtn.click(); } catch (e) {} await sleep(150); }
    // 2) preenche e confere
    user.focus(); setVal(user, ${u});
    pass.focus(); setVal(pass, ${p});
    await sleep(80);
    if (user.value !== ${u}) typeVal(user, ${u});
    if (pass.value !== ${p}) typeVal(pass, ${p});
    await sleep(80);
    if (user.value !== ${u} || pass.value !== ${p}) return { ok: false, step: 'fill-failed', message: 'os campos não aceitaram o valor' };
    // 3) Turnstile: o widget preenche o campo oculto sozinho no modo gerenciado.
    var token = form.querySelector('input[name="cf-turnstile-response"]');
    waited = 0;
    while (token && !token.value && waited < ${turnstileWaitMs}) { await sleep(250); waited += 250; }
    if (token && !token.value) return { ok: false, step: 'turnstile-timeout', message: 'Turnstile pede interação' };
    // 4) envia (o formulário pode ter sido re-renderizado enquanto esperávamos: relê)
    var again = find();
    form = again.form || form;
    var btn = form.querySelector('button[type="submit"], .submit-form');
    if (btn) btn.click(); else if (form.requestSubmit) form.requestSubmit(); else form.submit();
    return { ok: true, step: 'submitted' };
  })()`;
}
