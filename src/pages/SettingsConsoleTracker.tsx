import { ConfigCheckbox, ConfigInput } from '../components/ConfigInputs';
import SettingsShell, { EngineToggle, Section, TextField } from '../components/SettingsShell';
import type { ConsoleTrackerConfig } from '../../shared/addon-config';
import type { AddonSettingsProps } from '../addons/types';
export type { ConsoleTrackerConfig } from '../../shared/addon-config';

export default function SettingsConsoleTracker({ config, setConfig, defaultConfig, isDirty, onSave, onRevert, onBack, showToast, leaveWarning, onLeaveWarning }: AddonSettingsProps<ConsoleTrackerConfig>) {
  const engine = config.engine ?? 'protocol';
  const reset = () => { setConfig(defaultConfig); showToast('Configurações restauradas ao padrão'); };

  return (
    <SettingsShell title="Console Tracker" isDirty={isDirty} onSave={onSave} onRevert={onRevert} onBack={onBack} onReset={reset} leaveWarning={leaveWarning} onLeaveWarning={onLeaveWarning}>
      <Section title="Motor">
        <EngineToggle
          engine={engine}
          onChange={(e) => setConfig((c) => ({ ...c, engine: e }))}
          label="Usar protocolo (1587 recebido → 3567 de volta)"
          hint="Responde mensagens do console pelo pacote do messenger, sem abrir janela nem limpar chats. Desligado = script antigo que abre o console e clica."
        />
        {engine === 'protocol' && (
          <div className="mt-3 space-y-3">
            <div className="w-64">
              <ConfigInput label="Mínimo entre respostas ao mesmo usuário (s)" value={config.minSecondsBetweenRepliesPerUser ?? 20} onChange={(v) => setConfig((c) => ({ ...c, minSecondsBetweenRepliesPerUser: Math.max(0, v) }))} hint="Evita ping-pong com outros bots de resposta automática." />
            </div>
            <ConfigCheckbox label="Responder apenas a mensagens novas" checked={config.respondOnlyToNewMessages} onChange={(v) => setConfig((c) => ({ ...c, respondOnlyToNewMessages: v }))} hint="Ignora mensagens antigas entregues no login (mais de 60 s desde o envio)." />
          </div>
        )}
      </Section>

      <Section title="Auto Response">
        {engine === 'dom' && (
          <div className="mb-4">
            <ConfigCheckbox label="Ativar Auto Response" checked={config.enabled} onChange={(v) => setConfig((c) => ({ ...c, enabled: v }))} hint="Quando habilitado, responde automaticamente a novas mensagens no console." />
          </div>
        )}
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
      </Section>

      {engine === 'dom' && (
        <>
          <Section title="Comportamento">
            <div className="space-y-3">
              <ConfigCheckbox label="Limpar todos os chats ao iniciar" checked={config.clearAllOnStart} onChange={(v) => setConfig((c) => ({ ...c, clearAllOnStart: v }))} hint="Ao ativar o addon, limpa todos os chats abertos antes de começar a monitorar." />
              <ConfigCheckbox label="Fechar console após limpar todos" checked={config.autoCloseAfterClear} onChange={(v) => setConfig((c) => ({ ...c, autoCloseAfterClear: v }))} hint="Fecha o console automaticamente após limpar todos os chats." />
              <ConfigCheckbox label="Responder apenas a mensagens novas" checked={config.respondOnlyToNewMessages} onChange={(v) => setConfig((c) => ({ ...c, respondOnlyToNewMessages: v }))} hint="Responde apenas quando detecta nova mensagem (botão com is-unseen). Desabilitado, responde sempre que o console é aberto." />
            </div>
          </Section>

          <Section title="Delays (em milissegundos)">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ConfigInput label="Entre ações" value={config.delayBetweenActions} onChange={(v) => setConfig((c) => ({ ...c, delayBetweenActions: Math.max(0, v) }))} hint="Entre clicar em um usuário e no próximo." />
              <ConfigInput label="Após selecionar usuário" value={config.delayAfterSelect} onChange={(v) => setConfig((c) => ({ ...c, delayAfterSelect: Math.max(0, v) }))} hint="Antes de enviar mensagem ou limpar." />
              <ConfigInput label="Após limpar" value={config.delayAfterClear} onChange={(v) => setConfig((c) => ({ ...c, delayAfterClear: Math.max(0, v) }))} hint="Antes de passar para o próximo usuário." />
            </div>
            <p className="mt-3 text-[10px] text-dim border-t border-line pt-3">Logs de debug com prefixo <strong>[CT]</strong> aparecem no painel Logs abaixo.</p>
          </Section>
        </>
      )}
    </SettingsShell>
  );
}
