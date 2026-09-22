import { ConfigInput } from '../components/ConfigInputs';
import SettingsShell, { EngineToggle, Section, TagListEditor } from '../components/SettingsShell';
import type { CommandsLoopConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { CommandsLoopConfig } from '../../shared/addon-config';

export default function SettingsCommandsLoop({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<CommandsLoopConfig>) {
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Auto Message" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Motor">
        <EngineToggle
          engine={config.engine ?? 'protocol'}
          onChange={(e) => setConfig((c) => ({ ...c, engine: e }))}
          label="Usar protocolo (envia pelo pacote 1314)"
          hint="Cada item vira um pacote de fala direto para o servidor; comandos como :sit funcionam igual. Desligado = script antigo que digita no campo de chat."
        />
      </Section>

      <Section title="Mensagens e comandos" hint="Ative o addon na lista de Addons. Lista enviada em sequência, no intervalo definido.">
        <div className="flex flex-wrap gap-3">
          <div className="w-40"><ConfigInput label="Intervalo do loop (s)" value={Math.round(config.extraCommandsIntervalMs / 1000)} onChange={(v) => setConfig((c) => ({ ...c, extraCommandsIntervalMs: Math.max(5, v) * 1000 }))} hint="A cada quantos segundos a lista é executada." /></div>
          <div className="w-36"><ConfigInput label="Entre comandos (ms)" value={config.extraBetweenCommandsMs} onChange={(v) => setConfig((c) => ({ ...c, extraBetweenCommandsMs: Math.max(100, v) }))} /></div>
        </div>
        <div className="mt-3">
          <TagListEditor values={config.extraCommands ?? []} onChange={(v) => setConfig((c) => ({ ...c, extraCommands: v }))} placeholder="Ex.: :sit" />
        </div>
      </Section>
    </SettingsShell>
  );
}
