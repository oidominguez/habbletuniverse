/**
 * Resolução automática do Cloudflare Turnstile via serviço externo (chave do usuário).
 * Suporta 2Captcha e CapSolver, que usam a mesma forma createTask / getTaskResult.
 *
 * Fluxo: o renderer lê sitekey/action/cdata do widget na página de login, pede o token aqui,
 * injeta em `input[name=cf-turnstile-response]` e envia o formulário.
 */
import type { CaptchaSolverProvider, TurnstileSolveRequest, TurnstileSolveResult } from '../shared/crowd';

const ENDPOINTS: Record<Exclude<CaptchaSolverProvider, 'none'>, { create: string; result: string; taskType: string }> = {
  '2captcha': { create: 'https://api.2captcha.com/createTask', result: 'https://api.2captcha.com/getTaskResult', taskType: 'TurnstileTaskProxyless' },
  capsolver: { create: 'https://api.capsolver.com/createTask', result: 'https://api.capsolver.com/getTaskResult', taskType: 'AntiTurnstileTaskProxyLess' },
};

const POLL_MS = 4000;
const TIMEOUT_MS = 150000;

interface CreateResponse { errorId: number; errorCode?: string; errorDescription?: string; taskId?: string | number }
interface ResultResponse { errorId: number; errorCode?: string; errorDescription?: string; status?: string; solution?: { token?: string } }

export async function solveTurnstile(provider: CaptchaSolverProvider, apiKey: string, req: TurnstileSolveRequest): Promise<TurnstileSolveResult> {
  if (provider === 'none') return { ok: false, error: 'nenhum resolvedor configurado' };
  if (!apiKey) return { ok: false, error: 'chave da API do resolvedor vazia' };
  const ep = ENDPOINTS[provider];
  const task: Record<string, unknown> = { type: ep.taskType, websiteURL: req.url, websiteKey: req.sitekey };
  if (provider === '2captcha') {
    if (req.action) task.action = req.action;
    if (req.cdata) task.data = req.cdata;
    // Página de desafio do Cloudflare: exige pagedata + userAgent (o token só vale para esse UA).
    if (req.pagedata) task.pagedata = req.pagedata;
    if (req.userAgent) task.userAgent = req.userAgent;
  } else {
    if (req.pagedata) return { ok: false, error: 'CapSolver não resolve a página de desafio do Cloudflare (só o widget do login); use 2Captcha' };
    const metadata: Record<string, string> = {};
    if (req.action) metadata.action = req.action;
    if (req.cdata) metadata.cdata = req.cdata;
    if (Object.keys(metadata).length) task.metadata = metadata;
  }
  const started = Date.now();
  try {
    const created = (await postJson(ep.create, { clientKey: apiKey, task })) as CreateResponse;
    if (created.errorId) return { ok: false, error: `${created.errorCode ?? 'erro'}: ${created.errorDescription ?? ''}`.trim() };
    const taskId = created.taskId;
    if (taskId === undefined) return { ok: false, error: 'resposta sem taskId' };
    while (Date.now() - started < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = (await postJson(ep.result, { clientKey: apiKey, taskId })) as ResultResponse;
      if (res.errorId) return { ok: false, error: `${res.errorCode ?? 'erro'}: ${res.errorDescription ?? ''}`.trim() };
      if (res.status === 'ready' && res.solution?.token) return { ok: true, token: res.solution.token, elapsedMs: Date.now() - started };
    }
    return { ok: false, error: `resolvedor não respondeu em ${TIMEOUT_MS / 1000} s` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${new URL(url).host}`);
  return res.json();
}
