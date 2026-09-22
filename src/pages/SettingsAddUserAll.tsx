import { ConfigInput, ConfigCheckbox } from '../components/ConfigInputs';
import SettingsShell, { EngineToggle, Section, TagListEditor } from '../components/SettingsShell';
import type { AddUserAllConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { AddUserAllConfig } from '../../shared/addon-config';

export default function SettingsAddUserAll({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<AddUserAllConfig>) {
  const engine = config.engine ?? 'protocol';
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Add User All" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Motor">
        <EngineToggle
          engine={engine}
          onChange={(e) => setConfig((c) => ({ ...c, engine: e }))}
          label="Usar protocolo (sem :chooser, sem cliques)"
          hint="Lê os usuários da sala direto do servidor (pacote 374) e envia o pedido de amizade (3157) sem abrir menu. Desligado = script antigo que clica na interface."
        />
        {engine === 'protocol' && (
          <div className="mt-3 w-52">
            <ConfigInput label="Intervalo entre pedidos (ms)" value={config.protocolIntervalMs ?? 2500} onChange={(v) => setConfig((c) => ({ ...c, protocolIntervalMs: Math.max(800, v) }))} hint="mín. 800. Ritmo conservador evita limites do servidor." />
          </div>
        )}
      </Section>

      <Section title="Nomes a ignorar" hint="Usuários nesta lista não receberão pedido de amizade.">
        <TagListEditor values={config.ignoreNames} onChange={(v) => setConfig((c) => ({ ...c, ignoreNames: v }))} placeholder="Nome + Enter" />
      </Section>

      {engine === 'dom' && (
        <>
          <Section title="Comandos Essenciais">
            <ConfigCheckbox label="Ativar" checked={config.essentialCommandsEnabled ?? true} onChange={(v) => setConfig((c) => ({ ...c, essentialCommandsEnabled: v }))} hint="Ex.: :chooser para abrir a lista." />
            <div className="mt-2 flex flex-wrap gap-3">
              <div className="w-36"><ConfigInput label="Intervalo do loop (ms)" value={config.essentialCommandsIntervalMs ?? 5000} onChange={(v) => setConfig((c) => ({ ...c, essentialCommandsIntervalMs: Math.max(1000, v) }))} /></div>
              <div className="w-36"><ConfigInput label="Entre comandos (ms)" value={config.essentialBetweenCommandsMs ?? 1500} onChange={(v) => setConfig((c) => ({ ...c, essentialBetweenCommandsMs: Math.max(100, v) }))} /></div>
            </div>
            <div className="mt-2">
              <TagListEditor values={config.essentialCommands ?? [':chooser']} onChange={(v) => setConfig((c) => ({ ...c, essentialCommands: v }))} placeholder="Ex.: :chooser" />
            </div>
          </Section>

          <Section title="Timing">
            <div className="grid grid-cols-2 gap-3">
              <ConfigInput label="Delay entre cliques (ms)" value={config.clickDelay} onChange={(v) => setConfig((c) => ({ ...c, clickDelay: v }))} />
              <ConfigInput label="Timeout do menu (ms)" value={config.menuTimeout} onChange={(v) => setConfig((c) => ({ ...c, menuTimeout: v }))} />
              <ConfigInput label="Delay de processamento (ms)" value={config.processDelay} onChange={(v) => setConfig((c) => ({ ...c, processDelay: v }))} />
              <ConfigInput label="Reconciliação (ms)" value={config.reconcileInterval} onChange={(v) => setConfig((c) => ({ ...c, reconcileInterval: v }))} />
              <ConfigInput label="Fechar menu (ms)" value={config.menuCloseDelay ?? 80} onChange={(v) => setConfig((c) => ({ ...c, menuCloseDelay: v }))} />
              <ConfigInput label="Espera botão amizade (ms)" value={config.friendBtnWaitMs ?? 380} onChange={(v) => setConfig((c) => ({ ...c, friendBtnWaitMs: v }))} />
            </div>
          </Section>

          <Section title="Tentativas">
            <div className="grid grid-cols-2 gap-3">
              <ConfigInput label="Máx. tentativas" value={config.maxRetries} onChange={(v) => setConfig((c) => ({ ...c, maxRetries: v }))} />
              <ConfigInput label="Backoff linha (ms)" value={config.rowNotFoundBackoffMs ?? 500} onChange={(v) => setConfig((c) => ({ ...c, rowNotFoundBackoffMs: v }))} />
            </div>
          </Section>

          <Section>
            <ConfigCheckbox label="Colher ao rolar (scroll harvest)" checked={config.scrollHarvest ?? false} onChange={(v) => setConfig((c) => ({ ...c, scrollHarvest: v }))} hint="Rolar a lista para carregar mais linhas." />
          </Section>

        </>
      )}

      <Section title="Auto Room" hint={engine === 'protocol'
        ? 'Quando não sobra ninguém novo para adicionar por X segundos, busca quartos no navegador (pacote 249), entra no mais cheio ainda não visitado (2312) e adiciona todo mundo. Ao esgotar a lista, recomeça: loop infinito.'
        : 'Visita quartos automaticamente para adicionar usuários. Quando a fila estiver vazia, aguarda 5 segundos e vai para o próximo quarto.'}>
        <ConfigCheckbox label="Ativar Auto Room" checked={config.autoRoom ?? false} onChange={(v) => setConfig((c) => ({ ...c, autoRoom: v }))} />
        {engine === 'protocol' && (config.autoRoom ?? false) && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <ConfigInput label="Sem novidades por (s)" value={Math.round((config.autoRoomIdleMs ?? 12000) / 1000)} onChange={(v) => setConfig((c) => ({ ...c, autoRoomIdleMs: Math.max(3, v) * 1000 }))} hint="mín. 3 s. Tempo sem ninguém novo antes de trocar." />
            <ConfigInput label="Mínimo de usuários no quarto" value={config.autoRoomMinUsers ?? 3} onChange={(v) => setConfig((c) => ({ ...c, autoRoomMinUsers: Math.max(1, v) }))} hint="Quartos com menos gente são pulados." />
            <div className="col-span-2 space-y-1.5">
              <label className="block text-sm font-medium text-fg-2">Busca do navegador</label>
              <input
                type="text"
                value={config.autoRoomSearchCode ?? 'hotel_view'}
                onChange={(e) => setConfig((c) => ({ ...c, autoRoomSearchCode: e.target.value }))}
                placeholder="hotel_view"
                className="w-full rounded-xl border border-line bg-raised px-4 py-2.5 font-mono text-sm text-fg outline-none transition-colors placeholder-dim focus:border-accent focus:ring-2 focus:ring-accent/25"
              />
              <p className="text-[10px] text-dim">hotel_view = quartos populares · official_view = oficiais · roomads_view = promovidos. Só quartos abertos (sem senha ou campainha) são usados.</p>
            </div>
          </div>
        )}
      </Section>
    </SettingsShell>
  );
}
