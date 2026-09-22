/**
 * Scripts DOM antigos: carregamento e geração do JS de ativação/desativação no webview.
 * Tudo dirigido pelo registro (`def.dom`), sem código por addon aqui.
 */
import { useEffect, useState } from 'react';
import type { AddonConfigMap, AddonId } from '../../../shared/addon-config';
import { ADDONS } from '../registry';
import { engineOf } from '../types';
import type { AnyAddonDefinition } from '../types';

export type DomScripts = Partial<Record<AddonId, string>>;

export interface WebviewJs {
  executeJavaScript: (code: string) => Promise<unknown>;
}

/** Carrega o código de cada script DOM declarado no registro (uma vez). */
export function useDomScripts(): DomScripts {
  const [scripts, setScripts] = useState<DomScripts>({});
  useEffect(() => {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/*$/, '');
    for (const def of ADDONS) {
      if (!def.dom) continue;
      fetch(`${base}/scripts/${def.dom.file}`)
        .then((r) => r.text())
        .then((code) => setScripts((prev) => ({ ...prev, [def.id]: code })))
        .catch(() => setScripts((prev) => ({ ...prev, [def.id]: '' })));
    }
  }, []);
  return scripts;
}

export function domActivateJs(def: AnyAddonDefinition, config: unknown, script: string): string {
  if (!def.dom) return '';
  return def.dom.activate(JSON.stringify(config), JSON.stringify(script));
}

export function domDeactivateJs(def: AnyAddonDefinition): string {
  return def.dom?.deactivate ?? '';
}

/** JS que só atualiza a config do script já injetado (equivalente a "Salvar"). */
export function domApplyConfigJs(def: AnyAddonDefinition, config: unknown): string {
  if (!def.dom) return '';
  return `${def.dom.configGlobal}=${JSON.stringify(config)};`;
}

/**
 * Reaplica o estado de todos os addons no webview (após a página carregar):
 * ativa os que estão ligados no motor DOM e garante os demais desligados.
 */
export function injectAllDom(w: WebviewJs, configs: AddonConfigMap, enabled: Record<AddonId, boolean>, scripts: DomScripts): void {
  for (const def of ADDONS) {
    if (!def.dom) continue;
    const cfg = configs[def.id];
    const script = scripts[def.id];
    const active = enabled[def.id] && engineOf(def, cfg) === 'dom' && !!script;
    const js = active ? domActivateJs(def, cfg, script!) : domDeactivateJs(def);
    if (js) w.executeJavaScript(js).catch(() => {});
  }
}

/** JS que lê stats/logs dos scripts DOM de uma vez (para o polling do painel). */
export function buildPollJs(): string {
  const logSources = ADDONS.filter((d) => d.dom?.logs).map((d) => `{ id: ${JSON.stringify(d.id)}, list: (${d.dom!.logs!.global} || []).slice(-800) }`);
  return `(function(){
    try {
      var s = window.__ADDALL_STATS__ || null;
      return { stats: s, logs: [${logSources.join(',')}] };
    } catch (e) { return { stats: null, logs: [] }; }
  })()`;
}

/** JS que limpa os logs de todos os scripts DOM. */
export function buildClearLogsJs(): string {
  return ADDONS.filter((d) => d.dom?.logs)
    .map((d) => `if(${d.dom!.logs!.global})${d.dom!.logs!.global}=[];`)
    .join('') + 'if(window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__)window.__ADDALL_AUTOREPLY_WHISPERS_LOGS__=[];';
}

/** Prefixo de exibição dos logs DOM de cada addon. */
export function domLogPrefix(id: AddonId): string {
  return ADDONS.find((d) => d.id === id)?.dom?.logs?.prefix ?? '';
}
