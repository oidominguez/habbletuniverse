import { ConfigInput } from '../components/ConfigInputs';
import SettingsShell, { Section, TagListEditor } from '../components/SettingsShell';
import type { AutoAcceptConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { AutoAcceptConfig } from '../../shared/addon-config';

export default function SettingsAutoAccept({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<AutoAcceptConfig>) {
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Auto Aceitar" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Como funciona" hint="Quando alguém pede sua amizade, o servidor manda o pacote 2219. Este addon responde com o pacote 137 (aceitar) depois do atraso abaixo. Funciona só por protocolo: não abre o console nem clica em nada.">
        <div className="w-52">
          <ConfigInput label="Atraso antes de aceitar (ms)" value={config.delayMs} onChange={(v) => setConfig((c) => ({ ...c, delayMs: Math.max(0, v) }))} hint="Um atraso pequeno parece mais natural do que aceitar no mesmo instante." />
        </div>
      </Section>

      <Section title="Nomes a ignorar" hint="Pedidos destes usuários ficam pendentes para você decidir manualmente na aba Jogo.">
        <TagListEditor values={config.ignoreNames} onChange={(v) => setConfig((c) => ({ ...c, ignoreNames: v }))} placeholder="Nome + Enter" />
      </Section>
    </SettingsShell>
  );
}
