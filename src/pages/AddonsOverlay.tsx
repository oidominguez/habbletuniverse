import { useCallback, useEffect, useState } from 'react';
import type { AddonId } from '../../shared/addon-config';
import { ADDONS, ADDON_BY_ID } from '../addons/registry';
import { engineOf } from '../addons/types';
import type { AddonStore } from '../addons/useAddonStore';
import { Switch } from '../components/ConfigInputs';
import { Button } from '../components/ui';
import { LiveDot } from '../components/Sky';
import { cx } from '../components/cx';
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
 * Gaveta de addons: uma folha em vidro que desliza da direita por cima do jogo. Lista com
 * interruptores e a tela de configurações do addon aberto, tudo no mesmo painel.
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
      <div className="absolute inset-0 bg-bg/45 backdrop-blur-[2px]" onClick={handleBackdropClick} aria-hidden />
      <aside className="glass-strong relative m-3 flex h-[calc(100%-24px)] w-full max-w-[520px] flex-col overflow-hidden rounded-[20px] shadow-drawer animate-slide-in-right">
        {open === null ? (
          <>
            <header className="flex shrink-0 flex-col gap-1.5 px-7 pb-5 pt-7">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-[26px] font-semibold tracking-tight text-fg">Addons</h2>
                <button onClick={close} className="flex h-8 w-8 items-center justify-center rounded-full bg-fg/[0.06] text-muted hover:text-fg" title="Fechar (Esc)" aria-label="Fechar">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <p className="text-[13.5px] leading-relaxed text-dim">
                Tudo roda pelo protocolo do jogo, sem tocar na tela. Ligue o que precisar; as configurações ficam salvas.
                {activeCount > 0 && <> <span className="text-muted">{activeCount} ativo{activeCount > 1 ? 's' : ''}.</span></>}
              </p>
            </header>
            <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
              <ul className="space-y-1.5">
                {ADDONS.map((def) => {
                  const enabled = store.enabled[def.id];
                  const engine = engineOf(def, store.configs[def.id]);
                  return (
                    <li key={def.id} className={cx('flex items-center gap-4 rounded-2xl border p-4 pl-[18px] transition-colors', enabled ? 'border-line-strong bg-fg/[0.045]' : 'border-line hover:border-line-strong')}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <h3 className={cx('text-[15px] font-semibold tracking-tight', enabled ? 'text-fg' : 'text-muted')}>{def.name}</h3>
                          {enabled && <span className="flex h-[18px] items-center gap-1.5 rounded-full bg-accent/[0.12] px-2 text-[10.5px] font-semibold text-accent"><LiveDot size={5} />ativo</span>}
                          <span className="text-[11px] text-dim">{engine === 'protocol' ? 'protocolo' : 'motor DOM'}</span>
                        </div>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-dim">{def.description}</p>
                        <button onClick={() => openSettings(def.id)} className={cx('mt-1.5 flex items-center gap-1 text-[12.5px] font-semibold hover:text-accent', enabled ? 'text-fg' : 'text-muted')}>
                          Configurar
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" /></svg>
                        </button>
                      </div>
                      <Switch checked={enabled} onChange={(v) => onToggle(def.id, v)} title={enabled ? 'Desativar' : 'Ativar'} />
                    </li>
                  );
                })}
              </ul>
            </main>
            <footer className="flex shrink-0 items-center gap-2 border-t border-line px-7 pb-5 pt-4">
              <span className="text-[12px] text-dim">Perfil de configurações</span>
              <span className="flex-1" />
              <Button size="md" onClick={onImportProfile} title="Carregar configurações de um arquivo .json">Importar</Button>
              <Button size="md" onClick={onExportProfile} title="Salvar as configurações atuais em um arquivo .json">Exportar</Button>
            </footer>
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
