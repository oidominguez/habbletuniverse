import type { ComponentType } from 'react';
import type { AddonConfigMap, AddonEngine, AddonId } from '../../shared/addon-config';

/** Props uniformes de toda tela de configurações de addon. */
export interface AddonSettingsProps<C> {
  config: C;
  setConfig: (c: C | ((p: C) => C)) => void;
  defaultConfig: C;
  isDirty: boolean;
  onSave: () => void;
  onRevert: () => void;
  onBack: () => void;
  showToast: (m: string) => void;
  /** Aviso "alterações não salvas" (controlado pelo pai: ele o liga ao clicar fora/Esc, a tela ao clicar em Voltar). */
  leaveWarning: boolean;
  onLeaveWarning: (show: boolean) => void;
}

/** Como injetar/controlar o script DOM antigo de um addon dentro do webview. */
export interface DomScriptSpec {
  /** Arquivo em public/scripts. */
  file: string;
  /** Global onde o script lê a configuração (ex.: `window.__ADDALL_CONFIG__`). */
  configGlobal: string;
  /** Global com os logs do script, se houver, e o prefixo para exibir no painel. */
  logs?: { global: string; prefix: string };
  /** JS que ativa/reativa o script. Recebe a config e o código já serializados em JSON. */
  activate: (configJson: string, scriptJson: string) => string;
  /** JS que pausa/desliga o script. */
  deactivate: string;
}

export interface AddonDefinition<K extends AddonId = AddonId> {
  id: K;
  name: string;
  description: string;
  defaultConfig: AddonConfigMap[K];
  /** 'both' = a config tem `engine` e o usuário escolhe; 'protocol' / 'dom' = fixo. */
  engines: 'protocol' | 'dom' | 'both';
  dom?: DomScriptSpec;
  Settings: ComponentType<AddonSettingsProps<AddonConfigMap[K]>>;
  /** Prefixo dos logs do motor por protocolo no painel Logs (ex.: `[Auto Message] `). */
  logPrefix: string;
}

/** Definição com o tipo de config apagado, para listas heterogêneas (registro, overlay). */
export type AnyAddonDefinition = Omit<AddonDefinition, 'defaultConfig' | 'Settings'> & {
  defaultConfig: AddonConfigMap[AddonId];
  Settings: ComponentType<AddonSettingsProps<AddonConfigMap[AddonId]>>;
};

export function defineAddon<K extends AddonId>(def: AddonDefinition<K>): AnyAddonDefinition {
  return def as unknown as AnyAddonDefinition;
}

/** Motor efetivo de um addon para a config atual. */
export function engineOf(def: Pick<AnyAddonDefinition, 'engines'>, config: unknown): AddonEngine {
  if (def.engines === 'dom') return 'dom';
  if (def.engines === 'protocol') return 'protocol';
  return (config as { engine?: AddonEngine }).engine ?? 'protocol';
}
