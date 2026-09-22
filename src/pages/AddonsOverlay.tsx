import { useCallback, useEffect, useState } from 'react';
import type { AddonId } from '../../shared/addon-config';
import { ADDONS, ADDON_BY_ID } from '../addons/registry';
import { engineOf } from '../addons/types';
import type { AddonStore } from '../addons/useAddonStore';
import { Switch } from '../components/ConfigInputs';
export type { AddonId } from '../../shared/addon-config';

interface AddonsOverlayProps {
  store: AddonStore;
  addonSettingsOpen: AddonId | null;
  onClose: () => void;
  onBack: () => void;
  onOpenSettings: (id: AddonId) => void;
  onToggle: (id: AddonId, enabled: boolean) => void;
  onSave: (id: AddonId) => void;
  onRevert: (id: AddonId) => void;
  onExportProfile: () => void;
  onImportProfile: () => void;
  showToast: (m: string) => void;
}

/**
 * Gaveta de addons: desliza da direita por cima do jogo. Lista com interruptores e
 * a tela de configurações do addon aberto, tudo no mesmo painel.
 */
export default function AddonsOverlay({ store, addonSettingsOpen, onClose, onBack, onOpenSettings, onToggle, onSave, onRevert, onExportProfile, onImportProfile, showToast }: AddonsOverlayProps) {
  // Aviso "não salvo" da tela aberta. Some ao trocar de tela/fechar: os handlers abaixo zeram antes de navegar.
  const [showLeaveWarning, setShowLeaveWarning] = useState(false);

  const hasUnsaved = addonSettingsOpen !== null && store.dirty[addonSettingsOpen];
  const open = addonSettingsOpen ? ADDON_BY_ID[addonSettingsOpen] : null;
  const activeCount = ADDONS.filter((d) => store.enabled[d.id]).length;

  const back = useCallback(() => { setShowLeaveWarning(false); onBack(); }, [onBack]);
  const close = useCallback(() => { setShowLeaveWarning(false); onClose(); }, [onClose]);
  const openSettings = (id: AddonId) => { setShowLeaveWarning(false); onOpenSettings(id); };

  const handleBackdropClick = () => {
    if (open) {
      if (hasUnsaved) setShowLeaveWarning(true);
      else back();
    } else {
      close();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (open) {
        if (hasUnsaved) setShowLeaveWarning(true);
        else back();
      } else close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hasUnsaved, back, close]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-bg/60 backdrop-blur-[2px]" onClick={handleBackdropClick} aria-hidden />
      <aside className="relative flex h-full w-full max-w-[460px] flex-col border-l border-line bg-surface shadow-drawer animate-slide-in-right">
        {open === null ? (
          <>
            <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-fg">Addons</h2>
                <p className="text-[11px] text-dim">{activeCount === 0 ? 'nenhum ativo' : `${activeCount} ativo${activeCount > 1 ? 's' : ''}`}</p>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button onClick={onImportProfile} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-fg" title="Carregar configurações de um arquivo .json">Importar</button>
                <button onClick={onExportProfile} className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-fg" title="Salvar as configurações atuais em um arquivo .json">Exportar</button>
                <button onClick={close} className="ml-1 rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" title="Fechar (Esc)">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto p-3">
              <ul className="space-y-2">
                {ADDONS.map((def) => {
                  const enabled = store.enabled[def.id];
                  const engine = engineOf(def, store.configs[def.id]);
                  return (
                    <li key={def.id} className={`rounded-xl border p-3.5 transition-colors ${enabled ? 'border-accent/40 bg-accent/[0.04]' : 'border-line bg-bg/40 hover:border-line-strong'}`}>
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-[13px] font-semibold tracking-tight text-fg">{def.name}</h3>
                            <span className={`rounded px-1.5 py-px text-[9px] font-medium uppercase tracking-wider ${engine === 'protocol' ? 'bg-accent/15 text-accent' : 'bg-raised text-dim'}`}>{engine === 'protocol' ? 'protocolo' : 'dom'}</span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-dim">{def.description}</p>
                          <button onClick={() => openSettings(def.id)} className="mt-2 text-[11px] font-medium text-muted hover:text-accent">Configurações →</button>
                        </div>
                        <Switch checked={enabled} onChange={(v) => onToggle(def.id, v)} title={enabled ? 'Desativar' : 'Ativar'} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </main>
          </>
        ) : (
          <open.Settings
            config={store.configs[open.id]}
            setConfig={(c) => store.setConfig(open.id, c as never)}
            defaultConfig={open.defaultConfig}
            isDirty={store.dirty[open.id]}
            onSave={() => onSave(open.id)}
            onRevert={() => onRevert(open.id)}
            onBack={back}
            showToast={showToast}
            leaveWarning={showLeaveWarning}
            onLeaveWarning={setShowLeaveWarning}
          />
        )}
      </aside>
    </div>
  );
}
