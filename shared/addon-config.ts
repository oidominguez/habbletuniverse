/**
 * Tipos e padrões de configuração dos addons, compartilhados entre o processo
 * principal (persistência) e o renderer (telas de configuração).
 *
 * Só tipos e constantes puras — nada de Electron, Node ou DOM aqui.
 */

export type AddonId = 'adduserall' | 'automessage' | 'autoreplywhispers' | 'nudgeeveryone' | 'consoletracker' | 'autoaccept';

export const ADDON_IDS: readonly AddonId[] = [
  'adduserall',
  'automessage',
  'autoreplywhispers',
  'nudgeeveryone',
  'consoletracker',
  'autoaccept',
] as const;

/** Motor de um addon: 'protocol' age pelos pacotes do jogo; 'dom' usa o script antigo que mexe na interface. */
export type AddonEngine = 'protocol' | 'dom';

/* ---------------------------------- Add User All ---------------------------------- */

export interface AddUserAllConfig {
  ignoreNames: string[];
  clickDelay: number;
  menuTimeout: number;
  processDelay: number;
  reconcileInterval: number;
  maxRetries: number;
  menuCloseDelay?: number;
  rowNotFoundBackoffMs?: number;
  friendBtnWaitMs?: number;
  scrollHarvest?: boolean;
  essentialCommands?: string[];
  essentialCommandsEnabled?: boolean;
  essentialCommandsIntervalMs?: number;
  essentialBetweenCommandsMs?: number;
  autoRoom?: boolean;
  /** 'protocol' = lê a sala pelo pacote 374 e envia 3157 direto (sem :chooser); 'dom' = script antigo que clica na interface. */
  engine?: AddonEngine;
  /** Intervalo mínimo entre pedidos no motor por protocolo (ms). */
  protocolIntervalMs?: number;
  /** Auto Room (protocolo): sem ninguém novo para adicionar por este tempo, troca de quarto. */
  autoRoomIdleMs?: number;
  /** Auto Room (protocolo): ignora quartos com menos usuários que isto. */
  autoRoomMinUsers?: number;
  /** Auto Room (protocolo): código da busca do navegador (hotel_view = populares, official_view = oficiais). */
  autoRoomSearchCode?: string;
}

export const defaultAddUserAllConfig: AddUserAllConfig = {
  engine: 'protocol',
  protocolIntervalMs: 2500,
  autoRoomIdleMs: 12000,
  autoRoomMinUsers: 3,
  autoRoomSearchCode: 'hotel_view',
  ignoreNames: ['Dominguez', '-Teach'],
  clickDelay: 100,
  menuTimeout: 1200,
  processDelay: 140,
  reconcileInterval: 380,
  maxRetries: 5,
  menuCloseDelay: 80,
  rowNotFoundBackoffMs: 500,
  friendBtnWaitMs: 380,
  scrollHarvest: false,
  essentialCommands: [':chooser'],
  essentialCommandsEnabled: true,
  essentialCommandsIntervalMs: 5000,
  essentialBetweenCommandsMs: 1500,
  autoRoom: false,
};

/* ---------------------------------- Auto Message ---------------------------------- */

export interface CommandsLoopConfig {
  extraCommands: string[];
  extraCommandsIntervalMs: number;
  extraBetweenCommandsMs: number;
  /** 'protocol' envia cada item pelo pacote 1314 (falar); 'dom' digita no campo de chat. */
  engine?: AddonEngine;
}

export const defaultCommandsLoopConfig: CommandsLoopConfig = {
  engine: 'protocol',
  extraCommands: [],
  extraCommandsIntervalMs: 60000,
  extraBetweenCommandsMs: 2000,
};

/* ------------------------- Automatically Reply to Whispers ------------------------- */

export interface AutoReplyWhispersConfig {
  message: string;
  /** Só no motor DOM: esconde a bolha do sussurro recebido. */
  hideMessage: boolean;
  alternationPrefix: string;
  /** 'protocol' responde ao 2704 com 1543; 'dom' observa bolhas na tela e digita no chat. */
  engine?: AddonEngine;
}

export const defaultAutoReplyWhispersConfig: AutoReplyWhispersConfig = {
  engine: 'protocol',
  message: 'Mensagem Automática: Estou ausente.',
  hideMessage: false,
  alternationPrefix: '- ',
};

/* --------------------------------- Nudge Everyone --------------------------------- */

export interface NudgeEveryoneConfig {
  ignoreNames: string[];
  essentialCommands: string[];
  essentialCommandsEnabled: boolean;
  essentialCommandsIntervalMs: number;
  essentialBetweenCommandsMs: number;
  intervalBetweenClicksMs: number;
  intervalBetweenLoopsMs: number;
  scrollHarvest?: boolean;
  /**
   * 'protocol' reproduz o clique pelo quarteto 3301+431+2091+2138 (experimental, sem :chooser);
   * 'dom' clica na lista da interface. Padrão 'dom' até o efeito do protocolo ser confirmado ao vivo.
   */
  engine?: AddonEngine;
}

export const defaultNudgeEveryoneConfig: NudgeEveryoneConfig = {
  engine: 'dom',
  ignoreNames: [],
  essentialCommands: [':chooser'],
  essentialCommandsEnabled: true,
  essentialCommandsIntervalMs: 5000,
  essentialBetweenCommandsMs: 1500,
  intervalBetweenClicksMs: 1000,
  intervalBetweenLoopsMs: 5000,
  scrollHarvest: false,
};

/* --------------------------------- Console Tracker -------------------------------- */

export interface ConsoleTrackerConfig {
  /** Só no motor DOM. */
  enabled: boolean;
  message: string;
  alternationPrefix: string;
  clearAllOnStart: boolean;
  autoCloseAfterClear: boolean;
  delayBetweenActions: number;
  delayAfterClear: number;
  delayAfterSelect: number;
  respondOnlyToNewMessages: boolean;
  /** 'protocol' responde ao 1587 com 3567; 'dom' abre o console e clica. */
  engine?: AddonEngine;
  /** Motor protocolo: não responde ao mesmo usuário de novo antes deste intervalo. */
  minSecondsBetweenRepliesPerUser?: number;
}

export const defaultConsoleTrackerConfig: ConsoleTrackerConfig = {
  engine: 'protocol',
  minSecondsBetweenRepliesPerUser: 20,
  enabled: false,
  message: 'Mensagem Automática: Estou ausente.',
  alternationPrefix: '- ',
  clearAllOnStart: true,
  autoCloseAfterClear: true,
  delayBetweenActions: 200,
  delayAfterClear: 150,
  delayAfterSelect: 300,
  respondOnlyToNewMessages: true,
};

/* ---------------------------------- Auto Aceitar ---------------------------------- */

export interface AutoAcceptConfig {
  /** Pedidos destes nomes ficam pendentes para decisão manual. */
  ignoreNames: string[];
  /** Atraso entre receber o pedido (2219) e aceitar (137). */
  delayMs: number;
}

export const defaultAutoAcceptConfig: AutoAcceptConfig = {
  ignoreNames: [],
  delayMs: 1500,
};

/* ------------------------------ Mapa id → tipo de config ------------------------------ */

export interface AddonConfigMap {
  adduserall: AddUserAllConfig;
  automessage: CommandsLoopConfig;
  autoreplywhispers: AutoReplyWhispersConfig;
  nudgeeveryone: NudgeEveryoneConfig;
  consoletracker: ConsoleTrackerConfig;
  autoaccept: AutoAcceptConfig;
}

export const defaultAddonConfigs: AddonConfigMap = {
  adduserall: defaultAddUserAllConfig,
  automessage: defaultCommandsLoopConfig,
  autoreplywhispers: defaultAutoReplyWhispersConfig,
  nudgeeveryone: defaultNudgeEveryoneConfig,
  consoletracker: defaultConsoleTrackerConfig,
  autoaccept: defaultAutoAcceptConfig,
};

/* --------------------------------- Protocolo --------------------------------- */

export interface ProtocolSettings {
  /** Rótulos dados pelo usuário a headers de pacote. Chave "in:123" ou "out:456" → nome. */
  headerLabels: Record<string, string>;
}

export const defaultProtocolSettings: ProtocolSettings = { headerLabels: {} };

/* --------------------------------- Estado persistido --------------------------------- */

/** Versão do formato salvo em disco. Incrementar ao mudar o formato e escrever migração em electron/store.ts. */
export const SETTINGS_VERSION = 1;

export interface PersistedSettings {
  version: number;
  /** Configuração salva (a que foi aplicada com "Salvar") de cada addon. */
  addons: AddonConfigMap;
  /** Quais addons estavam ativos ao fechar. */
  enabled: Record<AddonId, boolean>;
  /** Última URL carregada no webview. */
  lastUrl: string;
  ui: {
    panelHeight: number;
    panelCollapsed: boolean;
    sidebarCollapsed: boolean;
    panelTab: 'logs' | 'board' | 'protocol' | 'game' | 'crowd';
  };
  protocol: ProtocolSettings;
}

export const defaultSettings: PersistedSettings = {
  version: SETTINGS_VERSION,
  addons: defaultAddonConfigs,
  enabled: {
    adduserall: false,
    automessage: false,
    autoreplywhispers: false,
    nudgeeveryone: false,
    consoletracker: false,
    autoaccept: false,
  },
  lastUrl: '',
  ui: {
    panelHeight: 220,
    panelCollapsed: false,
    sidebarCollapsed: false,
    panelTab: 'logs',
  },
  protocol: defaultProtocolSettings,
};

/** Patch parcial aceito por `settings.update`. Só o primeiro nível de `addons`/`enabled`/`ui` é mesclado. */
export interface SettingsPatch {
  addons?: Partial<AddonConfigMap>;
  enabled?: Partial<Record<AddonId, boolean>>;
  lastUrl?: string;
  ui?: Partial<PersistedSettings['ui']>;
  /** `headerLabels` substitui o mapa inteiro. */
  protocol?: Partial<ProtocolSettings>;
}

/* --------------------------------- Saneamento --------------------------------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Copia de `input` apenas as chaves que existem em `defaults`, exigindo o mesmo tipo
 * primitivo (ou array de strings quando o padrão é array). Chaves desconhecidas são
 * descartadas e valores inválidos caem no padrão. Usado ao carregar do disco e ao importar.
 */
export function sanitizeLike<T extends object>(defaults: T, input: unknown): T {
  if (!isPlainObject(input)) return { ...defaults };
  const out = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const def = (defaults as Record<string, unknown>)[key];
    const val = input[key];
    if (val === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(val) && val.every((x) => typeof x === 'string')) out[key] = [...val];
    } else if (isPlainObject(def)) {
      out[key] = sanitizeLike(def, val);
    } else if (typeof val === typeof def) {
      out[key] = val;
    }
  }
  return out as T;
}

/** Mapa string → string; qualquer outra coisa é descartada. */
export function sanitizeStringMap(input: unknown, maxEntries = 5000): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(input)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== 'string' || !k) continue;
    out[k] = v.slice(0, 120);
    if (++n >= maxEntries) break;
  }
  return out;
}

/** Normaliza um objeto arbitrário (arquivo importado, disco) para um PersistedSettings válido. */
export function sanitizeSettings(input: unknown): PersistedSettings {
  const s = sanitizeLike(defaultSettings, input);
  s.version = SETTINGS_VERSION;
  const proto = isPlainObject(input) && isPlainObject(input.protocol) ? input.protocol : {};
  s.protocol = { headerLabels: sanitizeStringMap(proto.headerLabels) };
  return s;
}

/** Aplica um patch parcial sobre as configurações atuais, sem perder chaves não mencionadas. */
export function applySettingsPatch(current: PersistedSettings, patch: SettingsPatch): PersistedSettings {
  const next: PersistedSettings = {
    ...current,
    addons: { ...current.addons },
    enabled: { ...current.enabled },
    ui: { ...current.ui },
    protocol: { headerLabels: { ...current.protocol.headerLabels } },
  };
  if (patch.addons) {
    for (const id of ADDON_IDS) {
      const cfg = patch.addons[id];
      if (cfg) (next.addons as Record<AddonId, unknown>)[id] = sanitizeLike(defaultAddonConfigs[id], cfg);
    }
  }
  if (patch.enabled) {
    for (const id of ADDON_IDS) {
      const v = patch.enabled[id];
      if (typeof v === 'boolean') next.enabled[id] = v;
    }
  }
  if (typeof patch.lastUrl === 'string') next.lastUrl = patch.lastUrl;
  if (patch.ui) next.ui = sanitizeLike(current.ui, { ...current.ui, ...patch.ui });
  if (patch.protocol?.headerLabels) next.protocol = { headerLabels: sanitizeStringMap(patch.protocol.headerLabels) };
  return next;
}
