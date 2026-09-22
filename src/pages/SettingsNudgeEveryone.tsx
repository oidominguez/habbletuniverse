import { ConfigInput, ConfigCheckbox } from '../components/ConfigInputs';
import SettingsShell, { EngineToggle, Section, TagListEditor } from '../components/SettingsShell';
import type { NudgeEveryoneConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { NudgeEveryoneConfig } from '../../shared/addon-config';

export default function SettingsNudgeEveryone({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<NudgeEveryoneConfig>) {
  const engine = config.engine ?? 'dom';
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Nudge Everyone" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Motor">
        <EngineToggle
          engine={engine}
          onChange={(e) => setConfig((c) => ({ ...c, engine: e }))}
          label="Usar protocolo (experimental)"
          hint="Reproduz o clique no avatar pelos pacotes que o cliente manda ao abrir o menu de um usuário (3301 olhar + 431 tags + 2091 emblemas + 2138 relacionamentos), lendo a sala pelo 374, sem :chooser. Ainda não confirmado ao vivo se o alvo recebe o aviso 'clicou em você'. Desligado = script antigo que clica na lista."
        />
      </Section>

      <Section title="Nomes a ignorar" hint="Usuários nesta lista não serão clicados.">
        <TagListEditor values={config.ignoreNames ?? []} onChange={(v) => setConfig((c) => ({ ...c, ignoreNames: v }))} placeholder="Nome + Enter" />
      </Section>

      {engine === 'dom' && (
      <Section title="Comandos Essenciais">
        <ConfigCheckbox label="Ativar" checked={config.essentialCommandsEnabled ?? true} onChange={(v) => setConfig((c) => ({ ...c, essentialCommandsEnabled: v }))} hint="Ex.: :chooser para abrir a lista de usuários." />
        <div className="mt-2 flex flex-wrap gap-3">
          <div className="w-36"><ConfigInput label="Intervalo do loop (ms)" value={config.essentialCommandsIntervalMs ?? 5000} onChange={(v) => setConfig((c) => ({ ...c, essentialCommandsIntervalMs: Math.max(1000, v) }))} /></div>
          <div className="w-36"><ConfigInput label="Entre comandos (ms)" value={config.essentialBetweenCommandsMs ?? 1500} onChange={(v) => setConfig((c) => ({ ...c, essentialBetweenCommandsMs: Math.max(100, v) }))} /></div>
        </div>
        <div className="mt-2">
          <TagListEditor values={config.essentialCommands ?? [':chooser']} onChange={(v) => setConfig((c) => ({ ...c, essentialCommands: v }))} placeholder="Ex.: :chooser" />
        </div>
      </Section>
      )}

      <Section title="Intervalos (em ms)" hint="X = pausa entre cada clique. Y = pausa após terminar a lista, antes de recomeçar o ciclo. Valores em milissegundos (ex.: 500, 1000, 2500).">
        <div className="grid grid-cols-2 gap-3">
          <ConfigInput label="Entre cliques (ms)" value={config.intervalBetweenClicksMs} onChange={(v) => setConfig((c) => ({ ...c, intervalBetweenClicksMs: Math.max(100, v) }))} hint="mín. 100" />
          <ConfigInput label="Entre ciclos (ms)" value={config.intervalBetweenLoopsMs} onChange={(v) => setConfig((c) => ({ ...c, intervalBetweenLoopsMs: Math.max(500, v) }))} hint="mín. 500" />
        </div>
      </Section>

      {engine === 'dom' && (
      <Section>
        <ConfigCheckbox label="Colher ao rolar (scroll harvest)" checked={config.scrollHarvest ?? false} onChange={(v) => setConfig((c) => ({ ...c, scrollHarvest: v }))} hint="Rolar a lista para carregar mais usuários antes de cada ciclo." />
      </Section>
      )}
    </SettingsShell>
  );
}
