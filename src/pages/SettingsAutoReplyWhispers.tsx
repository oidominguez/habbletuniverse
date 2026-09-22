import { ConfigCheckbox } from '../components/ConfigInputs';
import SettingsShell, { EngineToggle, Section, TextField } from '../components/SettingsShell';
import type { AutoReplyWhispersConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { AutoReplyWhispersConfig } from '../../shared/addon-config';

export default function SettingsAutoReplyWhispers({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<AutoReplyWhispersConfig>) {
  const engine = config.engine ?? 'protocol';
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Automatically Reply to Whispers" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Motor">
        <EngineToggle
          engine={engine}
          onChange={(e) => setConfig((c) => ({ ...c, engine: e }))}
          label="Usar protocolo (2704 recebido → 1543 de volta)"
          hint="Detecta o sussurro no pacote do servidor e responde com o pacote de sussurro, sem ler bolhas na tela. Desligado = script antigo que observa o chat e digita."
        />
      </Section>

      <Section title="Resposta automática" hint="Ao receber uma mensagem particular (sussurro), responde com um sussurro para quem mandou.">
        <TextField label="Mensagem" value={config.message} onChange={(v) => setConfig((c) => ({ ...c, message: v }))} placeholder="Ex.: Oi! Não estou disponível no momento." />
        <div className="mt-4">
          <TextField
            label="Prefixo na alternância"
            value={config.alternationPrefix}
            onChange={(v) => setConfig((c) => ({ ...c, alternationPrefix: v }))}
            placeholder="Ex.: -"
            hint={<>1.ª: <strong>&quot;&lt;mensagem&gt;&quot;</strong> — 2.ª: <strong>&quot;&lt;prefixo&gt;&lt;mensagem&gt;&quot;</strong>. Ex.: - vira &quot;-alou&quot;.</>}
          />
        </div>
        {engine === 'dom' && (
          <>
            <div className="mt-4">
              <ConfigCheckbox label="Ocultar mensagem recebida" checked={config.hideMessage} onChange={(v) => setConfig((c) => ({ ...c, hideMessage: v }))} hint="Se ativado, a bolha da mensagem particular é removida da tela após enviar a resposta." />
            </div>
            <p className="mt-3 text-[10px] text-dim border-t border-line pt-3">Logs de debug com prefixo <strong>[ARW]</strong> aparecem no painel Logs abaixo.</p>
          </>
        )}
      </Section>
    </SettingsShell>
  );
}
