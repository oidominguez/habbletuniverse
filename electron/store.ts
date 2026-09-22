import Store from 'electron-store';
import type { Rectangle } from 'electron';
import {
  applySettingsPatch,
  defaultSettings,
  sanitizeSettings,
  SETTINGS_VERSION,
} from '../shared/addon-config';
import type { PersistedSettings, SettingsPatch } from '../shared/addon-config';

/** Estado da janela principal, salvo no mesmo arquivo mas fora de PersistedSettings (não vai em perfil exportado). */
export interface WindowState {
  bounds?: Rectangle;
  maximized: boolean;
}

interface StoreSchema {
  settings: PersistedSettings;
  window: WindowState;
}

/**
 * Persistência em disco (JSON em %APPDATA%/habblet-addall/config.json).
 *
 * Tudo que entra passa por `sanitizeSettings`, então um arquivo editado à mão ou
 * de uma versão antiga nunca derruba o app: chaves desconhecidas são ignoradas e
 * valores inválidos voltam ao padrão.
 */
const store = new Store<StoreSchema>({
  name: 'config',
  defaults: {
    settings: defaultSettings,
    window: { maximized: true },
  },
  // Migrações por versão do formato. Adicionar entradas aqui ao incrementar SETTINGS_VERSION.
  migrations: {
    // '2.0.0': (s) => { ... }
  },
});

/** Garante formato válido mesmo se o arquivo em disco estiver corrompido/antigo. */
function readSettings(): PersistedSettings {
  const raw = store.get('settings');
  const clean = sanitizeSettings(raw);
  if (!raw || (raw as { version?: number }).version !== SETTINGS_VERSION) store.set('settings', clean);
  return clean;
}

export const settingsStore = {
  get(): PersistedSettings {
    return readSettings();
  },

  update(patch: SettingsPatch): PersistedSettings {
    const next = applySettingsPatch(readSettings(), patch);
    store.set('settings', next);
    return next;
  },

  reset(): PersistedSettings {
    store.set('settings', defaultSettings);
    return defaultSettings;
  },

  /** Substitui tudo por um objeto vindo de fora (perfil importado), saneando. */
  replace(input: unknown): PersistedSettings {
    const clean = sanitizeSettings(input);
    store.set('settings', clean);
    return clean;
  },

  /** Caminho do arquivo em disco (útil para diagnóstico). */
  get filePath(): string {
    return store.path;
  },
};

export const windowStore = {
  get(): WindowState {
    const w = store.get('window');
    return w && typeof w === 'object' ? w : { maximized: true };
  },
  set(state: WindowState): void {
    store.set('window', state);
  },
};
