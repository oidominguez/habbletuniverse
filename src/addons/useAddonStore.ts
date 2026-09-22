import { useCallback, useEffect, useRef, useState } from 'react';
import { ADDON_IDS, defaultAddonConfigs } from '../../shared/addon-config';
import type { AddonConfigMap, AddonId, PersistedSettings, SettingsPatch } from '../../shared/addon-config';

export type EnabledMap = Record<AddonId, boolean>;
export type DirtyMap = Record<AddonId, boolean>;

const allFalse = (): Record<AddonId, boolean> => Object.fromEntries(ADDON_IDS.map((id) => [id, false])) as Record<AddonId, boolean>;

export interface AddonStore {
  configs: AddonConfigMap;
  enabled: EnabledMap;
  dirty: DirtyMap;
  /** Edita a config (marca como não salva). */
  setConfig<K extends AddonId>(id: K, c: AddonConfigMap[K] | ((p: AddonConfigMap[K]) => AddonConfigMap[K])): void;
  /** Liga/desliga e persiste. */
  setEnabled(id: AddonId, v: boolean): void;
  /** Aplica: guarda como "último salvo", limpa o dirty e persiste. */
  save(id: AddonId): void;
  /** Volta ao "último salvo". */
  revert(id: AddonId): void;
  /** Guarda o estado atual como "último salvo" (ao abrir a tela de configurações). */
  snapshotLastSaved(id: AddonId): void;
  /** Carrega tudo do disco/perfil. `withEnabled` = também restaura quais estavam ativos. */
  hydrate(settings: PersistedSettings, withEnabled: boolean): void;
}

/**
 * Estado de todos os addons num só lugar: config em edição, "último salvo" (para Cancelar),
 * dirty e ativação. Persistência via `persist` (patch parcial para o electron-store).
 */
export function useAddonStore(persist: (patch: SettingsPatch) => void): AddonStore {
  const [configs, setConfigs] = useState<AddonConfigMap>(defaultAddonConfigs);
  const [enabled, setEnabledMap] = useState<EnabledMap>(allFalse);
  const [dirty, setDirty] = useState<DirtyMap>(allFalse);
  const lastSavedRef = useRef<AddonConfigMap>(defaultAddonConfigs);
  const configsRef = useRef<AddonConfigMap>(configs);
  useEffect(() => {
    configsRef.current = configs;
  }, [configs]);

  const setConfig = useCallback(<K extends AddonId>(id: K, c: AddonConfigMap[K] | ((p: AddonConfigMap[K]) => AddonConfigMap[K])) => {
    setConfigs((prev) => {
      const next = typeof c === 'function' ? (c as (p: AddonConfigMap[K]) => AddonConfigMap[K])(prev[id]) : c;
      return { ...prev, [id]: next };
    });
    setDirty((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  }, []);

  const setEnabled = useCallback(
    (id: AddonId, v: boolean) => {
      setEnabledMap((prev) => ({ ...prev, [id]: v }));
      persist({ enabled: { [id]: v } });
    },
    [persist],
  );

  const save = useCallback(
    (id: AddonId) => {
      const cfg = configsRef.current[id];
      lastSavedRef.current = { ...lastSavedRef.current, [id]: cfg };
      setDirty((prev) => ({ ...prev, [id]: false }));
      persist({ addons: { [id]: cfg } as Partial<AddonConfigMap> });
    },
    [persist],
  );

  const revert = useCallback((id: AddonId) => {
    setConfigs((prev) => ({ ...prev, [id]: lastSavedRef.current[id] }));
    setDirty((prev) => ({ ...prev, [id]: false }));
  }, []);

  const snapshotLastSaved = useCallback((id: AddonId) => {
    lastSavedRef.current = { ...lastSavedRef.current, [id]: configsRef.current[id] };
  }, []);

  const hydrate = useCallback((s: PersistedSettings, withEnabled: boolean) => {
    setConfigs(s.addons);
    lastSavedRef.current = s.addons;
    setDirty(allFalse());
    if (withEnabled) setEnabledMap({ ...allFalse(), ...s.enabled });
  }, []);

  return { configs, enabled, dirty, setConfig, setEnabled, save, revert, snapshotLastSaved, hydrate };
}
