/**
 * Registro de addons: cada addon é declarado uma única vez aqui.
 * Adicionar um addon novo = criar a tela de settings, a config em shared/addon-config.ts
 * (tipo, padrão, id) e uma entrada nesta lista. Nada mais no App.
 */
import {
  defaultAddUserAllConfig,
  defaultAutoAcceptConfig,
  defaultAutoReplyWhispersConfig,
  defaultCommandsLoopConfig,
  defaultConsoleTrackerConfig,
  defaultNudgeEveryoneConfig,
} from '../../shared/addon-config';
import type { AddonId } from '../../shared/addon-config';
import { defineAddon } from './types';
import type { AnyAddonDefinition } from './types';
import SettingsAddUserAll from '../pages/SettingsAddUserAll';
import SettingsCommandsLoop from '../pages/SettingsCommandsLoop';
import SettingsAutoReplyWhispers from '../pages/SettingsAutoReplyWhispers';
import SettingsNudgeEveryone from '../pages/SettingsNudgeEveryone';
import SettingsConsoleTracker from '../pages/SettingsConsoleTracker';
import SettingsAutoAccept from '../pages/SettingsAutoAccept';

export const ADDONS: readonly AnyAddonDefinition[] = [
  defineAddon({
    id: 'adduserall',
    name: 'Add User All',
    description:
      'Envia pedidos de amizade para todos na sala. Por padrão usa o protocolo (lê a sala do servidor e envia o pacote direto, sem :chooser nem cliques); o modo DOM antigo fica nas configurações.',
    defaultConfig: defaultAddUserAllConfig,
    engines: 'both',
    logPrefix: '',
    dom: {
      file: 'addall-injectable.js',
      configGlobal: 'window.__ADDALL_CONFIG__',
      logs: { global: 'window.__ADDALL_LOGS__', prefix: '' },
      activate: (cfg, script) => `window.__ADDALL_CONFIG__=${cfg};window.__ADDALL_PAUSE__=false;if(!window.__ADDALL_LOADED__){eval(${script});}`,
      deactivate: 'window.__ADDALL_PAUSE__=true;',
    },
    Settings: SettingsAddUserAll,
  }),
  defineAddon({
    id: 'automessage',
    name: 'Auto Message',
    description: 'Envia mensagens ou comandos no chat em intervalo (ex.: :sit, :stand, ou frases). Por padrão via protocolo (pacote 1314).',
    defaultConfig: defaultCommandsLoopConfig,
    engines: 'both',
    logPrefix: '[Auto Message] ',
    dom: {
      file: 'addall-commandsloop-injectable.js',
      configGlobal: 'window.__ADDALL_COMMANDSLOOP_CONFIG__',
      activate: (cfg, script) => `window.__ADDALL_COMMANDSLOOP_CONFIG__=${cfg};window.__ADDALL_COMMANDSLOOP_ENABLED__=true;eval(${script});`,
      deactivate: 'window.__ADDALL_COMMANDSLOOP_ENABLED__=false;window.__ADDALL_COMMANDSLOOP_LOCK__=false;',
    },
    Settings: SettingsCommandsLoop,
  }),
  defineAddon({
    id: 'autoreplywhispers',
    name: 'Automatically Reply to Whispers',
    description: 'Ao receber sussurro, responde com um sussurro para quem mandou. Por padrão via protocolo (2704 → 1543), sem ler a tela.',
    defaultConfig: defaultAutoReplyWhispersConfig,
    engines: 'both',
    logPrefix: '[Sussurros] ',
    dom: {
      file: 'addall-autoreply-whispers-injectable.js',
      configGlobal: 'window.__ADDALL_AUTOREPLY_WHISPERS_CONFIG__',
      activate: (cfg, script) => `window.__ADDALL_AUTOREPLY_WHISPERS_CONFIG__=${cfg};window.__ADDALL_AUTOREPLY_WHISPERS_ENABLED__=true;eval(${script});`,
      deactivate: 'window.__ADDALL_AUTOREPLY_WHISPERS_ENABLED__=false;',
    },
    Settings: SettingsAutoReplyWhispers,
  }),
  defineAddon({
    id: 'nudgeeveryone',
    name: 'Nudge Everyone',
    description: 'Clica nas pessoas da sala, 1 a 1 (sem adicionar). Intervalo X entre cliques, loop a cada Y segundos. Por padrão via DOM (:chooser + clique); o motor por protocolo (experimental) reproduz o clique pelos pacotes 3301+431+2091+2138.',
    defaultConfig: defaultNudgeEveryoneConfig,
    engines: 'both',
    logPrefix: '[Nudge] ',
    dom: {
      file: 'nudge-everyone-injectable.js',
      configGlobal: 'window.__NUDGE_CONFIG__',
      logs: { global: 'window.__NUDGE_LOGS__', prefix: '[Nudge] ' },
      activate: (cfg, script) => `window.__NUDGE_CONFIG__=${cfg};window.__NUDGE_PAUSE__=false;if(!window.__NUDGE_LOADED__){eval(${script});}`,
      deactivate: 'window.__NUDGE_PAUSE__=true;',
    },
    Settings: SettingsNudgeEveryone,
  }),
  defineAddon({
    id: 'autoaccept',
    name: 'Auto Aceitar',
    description: 'Aceita pedidos de amizade recebidos automaticamente (2219 → 137), com atraso e lista de ignorados. Só por protocolo.',
    defaultConfig: defaultAutoAcceptConfig,
    engines: 'protocol',
    logPrefix: '[Auto Aceitar] ',
    Settings: SettingsAutoAccept,
  }),
  defineAddon({
    id: 'consoletracker',
    name: 'Console Tracker',
    description: 'Responde automaticamente mensagens recebidas no console. Por padrão via protocolo (1587 → 3567), sem abrir janela.',
    defaultConfig: defaultConsoleTrackerConfig,
    engines: 'both',
    logPrefix: '[Console] ',
    dom: {
      file: 'console-tracker-injectable.js',
      configGlobal: 'window.__CONSOLE_TRACKER_CONFIG__',
      logs: { global: 'window.__CONSOLE_TRACKER_LOGS__', prefix: '[CT] ' },
      activate: (cfg, script) =>
        `window.__CONSOLE_TRACKER_CONFIG__=${cfg};window.__CONSOLE_TRACKER_ENABLED__=true;if(!window.__CONSOLE_TRACKER_LOADED__){if(window.__CONSOLE_TRACKER_INTERVAL__)clearInterval(window.__CONSOLE_TRACKER_INTERVAL__);if(window.__CONSOLE_TRACKER_WATCHDOG__)clearInterval(window.__CONSOLE_TRACKER_WATCHDOG__);if(window.__CONSOLE_TRACKER_CONFIG_WATCHER__)clearInterval(window.__CONSOLE_TRACKER_CONFIG_WATCHER__);window.__CONSOLE_TRACKER_LOADED__=false;eval(${script});}`,
      deactivate: 'window.__CONSOLE_TRACKER_ENABLED__=false;if(window.__CONSOLE_TRACKER_WATCHDOG__)clearInterval(window.__CONSOLE_TRACKER_WATCHDOG__);',
    },
    Settings: SettingsConsoleTracker,
  }),
];

export const ADDON_BY_ID: Record<AddonId, AnyAddonDefinition> = Object.fromEntries(ADDONS.map((a) => [a.id, a])) as Record<
  AddonId,
  AnyAddonDefinition
>;
