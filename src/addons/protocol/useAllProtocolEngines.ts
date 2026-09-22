/**
 * Liga os motores por protocolo da janela principal ao estado do registro.
 * Os motores em si são classes (engines.ts); aqui só existe o "relógio" e a ponte com o React.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddonConfigMap, AddonId } from '../../../shared/addon-config';
import type { GameState, GameSnapshot } from '../../protocol/state/GameState';
import type { GameActions } from '../../protocol/actions';
import { ADDON_BY_ID } from '../registry';
import { engineOf } from '../types';
import { createEngineSet, EMPTY_ADDALL_STATS } from './engines';
import type { AddallStats } from './engines';

export type { AddallStats } from './engines';

const TICK_MS = 250;

export interface AllEnginesOptions {
  configs: AddonConfigMap;
  enabled: Record<AddonId, boolean>;
  state: GameState;
  snapshot: GameSnapshot;
  actions: GameActions;
  agentReady: boolean;
  log: (msg: string) => void;
}

function isProtocol(id: AddonId, configs: AddonConfigMap, enabled: Record<AddonId, boolean>): boolean {
  return enabled[id] && engineOf(ADDON_BY_ID[id], configs[id]) === 'protocol';
}

/** Devolve as estatísticas do Add User All por protocolo (os demais motores só produzem logs). */
export function useAllProtocolEngines(o: AllEnginesOptions): AddallStats {
  const optsRef = useRef(o);
  useEffect(() => {
    optsRef.current = o;
  }, [o]);
  const engines = useMemo(() => createEngineSet(), []);
  const [stats, setStats] = useState<AddallStats>(EMPTY_ADDALL_STATS);

  useEffect(() => {
    let lastVersion = -1;
    const id = setInterval(() => {
      const cur = optsRef.current;
      const now = Date.now();
      const base = { now, agentReady: cur.agentReady, snapshot: cur.snapshot, state: cur.state, actions: cur.actions };
      const mk = (aid: AddonId) => (m: string) => cur.log(ADDON_BY_ID[aid].logPrefix + m);
      engines.adduserall.tick({ ...base, enabled: isProtocol('adduserall', cur.configs, cur.enabled), config: cur.configs.adduserall, log: mk('adduserall') });
      engines.automessage.tick({ ...base, enabled: isProtocol('automessage', cur.configs, cur.enabled), config: cur.configs.automessage, log: mk('automessage') });
      engines.autoreplywhispers.tick({ ...base, enabled: isProtocol('autoreplywhispers', cur.configs, cur.enabled), config: cur.configs.autoreplywhispers, log: mk('autoreplywhispers') });
      engines.consoletracker.tick({ ...base, enabled: isProtocol('consoletracker', cur.configs, cur.enabled), config: cur.configs.consoletracker, log: mk('consoletracker') });
      engines.autoaccept.tick({ ...base, enabled: isProtocol('autoaccept', cur.configs, cur.enabled), config: cur.configs.autoaccept, log: mk('autoaccept') });
      engines.nudgeeveryone.tick({ ...base, enabled: isProtocol('nudgeeveryone', cur.configs, cur.enabled), config: cur.configs.nudgeeveryone, log: mk('nudgeeveryone') });
      if (engines.adduserall.statsVersion !== lastVersion) {
        lastVersion = engines.adduserall.statsVersion;
        setStats(engines.adduserall.stats);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [engines]);

  return stats;
}
