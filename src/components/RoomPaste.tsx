/**
 * "Colar quarto" como assistente em cinco passos: Arquivo → Opções → Prévia e confirmação → Construção →
 * Conferência por coordenada. Carrega um JSON do "Copiar quarto", mostra a prévia (o que vem do inventário,
 * o que será comprado e por quanto, o que não está à venda) e roda o RoomPasteEngine com confirmação
 * explícita antes de qualquer compra. Ocupa a folha inteira da Sala enquanto aberto.
 */
import { useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { RoomCopy } from '../protocol/roomCopy';
import { BUILD_FLOOR, MAX_FIX_ATTEMPTS, MAX_PURCHASE_QTY, PASTE_PACES, auditIsClean, auditReportText, isIgnored, purchaseCalls } from '../protocol/roomPaste';
import type { PasteOptions, PastePhase } from '../protocol/roomPaste';
import type { GameSnapshot } from '../protocol/state/GameState';
import { pasteSession } from './pasteSession';
import { Switch } from './ConfigInputs';
import { Button, Chip, Eyebrow, Input, SegmentedTabs } from './ui';
import { LiveDot } from './Sky';
import { cx } from './cx';
import { cleanName } from './text';

export interface RoomPasteProps {
  game: GameSnapshot;
  agentReady: boolean;
  showToast: (msg: string) => void;
  onClose: () => void;
}

const PHASE_LABEL: Record<PastePhase, string> = {
  idle: 'aguardando',
  loading: 'lendo inventário e catálogo',
  pricing: 'lendo preços',
  preview: 'prévia — confirme para continuar',
  buying: 'comprando',
  floorplan: 'salvando a planta de obra',
  placing: 'colocando mobis',
  verifying: 'verificação',
  paint: 'aplicando pintura',
  'floorplan-final': 'aplicando a planta final',
  refining: 'refino final (altura, rotação e estado)',
  done: 'concluído',
  error: 'erro',
  cancelled: 'cancelado',
};

type Step = 1 | 2 | 3 | 4 | 5;
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Arquivo' },
  { n: 2, label: 'Opções' },
  { n: 3, label: 'Prévia e confirmação' },
  { n: 4, label: 'Construção' },
  { n: 5, label: 'Conferência por coordenada' },
];
const BUILD_PHASES: PastePhase[] = ['buying', 'floorplan', 'placing', 'verifying', 'paint', 'floorplan-final', 'refining'];

function isRoomCopy(v: unknown): v is RoomCopy {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<RoomCopy>;
  return typeof c.version === 'number' && Array.isArray(c.floorItems) && Array.isArray(c.wallItems) && Array.isArray(c.shopping) && !!c.room;
}

/** Em que passo o motor está, pelo estado dele (o usuário pode voltar aos passos 1 e 2 enquanto nada roda). */
function stepOf(phase: PastePhase, hasCopy: boolean): Step {
  if (phase === 'loading' || phase === 'pricing' || phase === 'preview') return 3;
  if (BUILD_PHASES.includes(phase)) return 4;
  if (phase === 'done' || phase === 'error' || phase === 'cancelled') return 5;
  return hasCopy ? 2 : 1;
}

export default function RoomPaste({ game, agentReady, showToast, onClose }: RoomPasteProps) {
  // A sessão (motor, JSON, opções, relógio) vive fora do React: fechar o cartão não interrompe a colagem.
  const session = pasteSession;
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  const { engine, copy, fileName, options } = session;
  const [ignoreDraft, setIgnoreDraft] = useState('');
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const ignoredCount = copy ? copy.floorItems.filter((i) => isIgnored(options.ignore, i.type, i.name)).length + copy.wallItems.filter((i) => isIgnored(options.ignore, i.type, i.name)).length : 0;
  const setOptions = (update: (o: PasteOptions) => PasteOptions) => session.setOptions(update);
  const addIgnore = (raw: string) => {
    const items = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    setOptions((o) => ({ ...o, ignore: [...new Set([...o.ignore, ...items])] }));
    setIgnoreDraft('');
  };
  const fileRef = useRef<HTMLInputElement>(null);

  const loadFile = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isRoomCopy(parsed)) {
        showToast('Este arquivo não é uma cópia de quarto do Universe');
        return;
      }
      session.setCopy(parsed, file.name);
      setManualStep(null);
    } catch (e) {
      showToast('Não deu para ler o arquivo: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const prepare = () => {
    setManualStep(null);
    if (!session.start()) showToast('O motor ainda não está ligado ao jogo; tente de novo em instantes');
  };

  const audit = engine.audit;
  const auditProblems = audit ? [...audit.floor, ...audit.wall].filter((r) => !r.verdicts.includes('ok')) : [];
  const exportAudit = () => {
    if (!audit || !copy) return;
    const blob = new Blob([auditReportText(copy, audit)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conferencia-quarto-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Conferência exportada');
  };

  const plan = engine.plan;
  const buyLines = plan?.purchases.filter((p) => !p.blocked) ?? [];
  const blockedLines = plan?.purchases.filter((p) => p.blocked) ?? [];
  const busy = engine.active && engine.phase !== 'preview';
  const canPrepare = !!copy && agentReady && game.room.id !== null && !engine.active && session.bound;
  const autoStep = stepOf(engine.phase, !!copy);
  // Passos 1 e 2 podem ser revisitados enquanto o motor não está rodando; os outros seguem o motor.
  const step: Step = manualStep !== null && !engine.active && (manualStep === 1 || manualStep === 2) ? manualStep : autoStep;
  const stepState = (n: Step): 'done' | 'now' | 'future' => (n === step ? 'now' : n < autoStep || (autoStep === 5 && n < 5) ? 'done' : 'future');
  const pct = engine.progress.total > 0 ? Math.min(100, Math.round((engine.progress.done / engine.progress.total) * 100)) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-5">
        <span className="font-display text-[14px] font-semibold text-fg">Colar quarto</span>
        <span className="truncate text-[12px] text-dim">reproduz num quarto seu um JSON do Copiar quarto: planta, pintura, mobis com posição, altura, direção e estado</span>
        <span className="flex-1" />
        {engine.active && <span className="flex items-center gap-1.5 text-[11.5px] text-accent"><LiveDot size={5} />{PHASE_LABEL[engine.phase]}</span>}
        {engine.active && <Button size="sm" variant="danger" onClick={() => session.cancel()}>Cancelar</Button>}
        <Button size="sm" onClick={onClose} title={engine.active ? 'A colagem continua em segundo plano; reabra para acompanhar' : undefined}>{engine.active ? 'Fechar (continua rodando)' : 'Voltar à sala'}</Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_360px]">
        {/* Trilho dos passos + resumo do arquivo */}
        <div className="flex min-h-0 flex-col gap-4 border-r border-line p-5">
          <ol className="flex flex-col gap-4">
            {STEPS.map((s) => {
              const st = stepState(s.n);
              const clickable = (s.n === 1 || s.n === 2) && !engine.active && !!copy;
              return (
                <li key={s.n}>
                  <button type="button" disabled={!clickable} onClick={() => setManualStep(s.n)} className={cx('flex items-center gap-2.5 text-left', clickable ? 'cursor-pointer' : 'cursor-default')}>
                    <span className={cx('tnum flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full font-mono text-[11px]', st === 'done' ? 'bg-fg text-bg' : st === 'now' ? 'border border-accent text-accent' : 'border border-line-strong text-dim')}>{st === 'done' ? '✓' : s.n}</span>
                    <span className={cx('text-[12.5px]', st === 'now' ? 'font-semibold text-fg' : st === 'done' ? 'text-fg-2' : 'text-dim')}>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {copy && (
            <div className="mt-auto flex flex-col gap-1.5 rounded-2xl border border-line bg-fg/[0.03] p-3.5">
              <span className="truncate text-[12.5px] font-semibold text-fg" title={copy.room.name ?? ''}>{cleanName(copy.room.name) || '#' + copy.room.id}{copy.room.ownerName ? <span className="font-normal text-dim"> · de {copy.room.ownerName}</span> : null}</span>
              <span className="truncate text-[11px] text-dim" title={fileName}>copiado em {new Date(copy.capturedAt).toLocaleString('pt-BR')} · {fileName}</span>
              <div className="mt-1 flex flex-wrap gap-1">
                <Chip>{copy.summary.floorItems} chão</Chip>
                <Chip>{copy.summary.wallItems} parede</Chip>
                <Chip>{copy.summary.types} tipos</Chip>
                {copy.floorPlan ? <Chip tone="accent">planta {copy.floorPlan.width}×{copy.floorPlan.height}</Chip> : <Chip tone="warn">sem planta</Chip>}
                {copy.summary.notPurchasable > 0 && <Chip tone="warn">{copy.summary.notPurchasable} sem oferta</Chip>}
                {ignoredCount > 0 && <Chip>{ignoredCount} ignorado(s)</Chip>}
              </div>
            </div>
          )}
        </div>

        {/* Conteúdo do passo */}
        <div className="flex min-h-0 flex-col overflow-y-auto border-r border-line p-5">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = ''; }} />

          {step === 1 && (
            <Pane title="Arquivo" hint="Um JSON gerado pelo Copiar quarto, desta ou de outra conta.">
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-line-strong p-6">
                <span className="text-[13px] text-fg-2">{fileName ? `Carregado: ${fileName}` : 'Nenhum arquivo carregado ainda.'}</span>
                <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}>{copy ? 'Trocar arquivo…' : 'Escolher arquivo…'}</Button>
              </div>
              {copy && <div className="mt-4"><Button onClick={() => setManualStep(2)}>Continuar para as opções →</Button></div>}
            </Pane>
          )}

          {step === 2 && copy && (
            <Pane title="Pronto para preparar a prévia" hint="A prévia lê o inventário (3150 → 994) e o índice do catálogo (1195 → 1032), desconta o que você já tem e mostra o custo. Nada é comprado antes da sua confirmação.">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="lg" onClick={prepare} disabled={!canPrepare} title={game.room.id === null ? 'Entre no seu quarto de destino' : !game.room.isOwner ? 'O servidor não confirmou que o quarto é seu (339)' : 'Lê inventário e catálogo e mostra a prévia com o custo'}>Preparar prévia</Button>
                  {game.room.id === null && <span className="text-warn">entre no quarto de destino</span>}
                  {!game.room.isOwner && game.room.id !== null && <span className="text-warn">este quarto não parece ser seu (sem o 339)</span>}
                  {!agentReady && <span className="text-warn">agente inativo: carregue o jogo</span>}
                </div>
                <p className="text-[11.5px] leading-relaxed text-dim">Destino: <span className="text-fg-2">{game.room.id !== null ? cleanName(game.room.name) || '#' + game.room.id : 'nenhum'}</span>. As opções ficam na coluna da direita e podem ser mudadas até aqui.</p>
              </div>
            </Pane>
          )}

          {step === 3 && (
            <Pane title={engine.phase === 'preview' ? 'Prévia' : PHASE_LABEL[engine.phase]} hint={engine.phase === 'preview' ? 'Confira o que será comprado e colocado. A compra só acontece depois do botão abaixo.' : engine.status}>
              {plan ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-1.5">
                    {engine.report.resumedFloor + engine.report.resumedWall > 0 && <Chip tone="accent" title="Já estão no quarto: não serão comprados nem colocados de novo; a verificação final acerta altura, rotação e estado.">{engine.report.resumedFloor + engine.report.resumedWall} já no quarto</Chip>}
                    {engine.report.strays > 0 && <Chip tone="warn" title="Mobis do mesmo tipo que estão no quarto fora de qualquer posição do JSON: sobra de uma interrupção, ou mobília que já era sua. Ficam onde estão.">{engine.report.strays} fora do JSON</Chip>}
                    <Chip tone="success">{plan.fromInventory} do inventário</Chip>
                    {plan.floorPlanChanges && <Chip tone="info">planta muda</Chip>}
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <Stat label="Compras" value={<>{buyLines.reduce((n, p) => n + p.quantity, 0)} <span className="font-sans text-[13px] text-dim">un. em {purchaseCalls(buyLines)}</span></>} hint={`máximo de ${MAX_PURCHASE_QTY} unidades por compra`} />
                    <Stat label="Créditos" value={plan.totalCredits} tone="text-warn" hint={plan.totalPoints > 0 ? `+ ${plan.totalPoints} pontos` : undefined} />
                    <Stat label="Sem oferta" value={plan.unpurchasable} tone={plan.unpurchasable > 0 ? 'text-danger' : 'text-fg'} />
                  </div>
                  {buyLines.length > 0 && (
                    <div>
                      <Eyebrow>Lista de compras</Eyebrow>
                      <ul className="mt-1.5 max-h-48 overflow-y-auto font-mono text-[11.5px]">
                        {buyLines.map((p) => (
                          <li key={`${p.kind}:${p.type}`} className="flex gap-3 truncate py-0.5">
                            <span className="tnum w-10 shrink-0 text-right text-fg-2" title={p.quantity > MAX_PURCHASE_QTY ? `${Math.ceil(p.quantity / MAX_PURCHASE_QTY)} compras de até ${MAX_PURCHASE_QTY}` : undefined}>{p.quantity}×</span>
                            <span className="min-w-0 flex-1 truncate text-fg">{p.name ?? '#' + p.type}{p.unitsPerOffer > 1 ? ` (pacote de ${p.unitsPerOffer})` : ''}</span>
                            <span className="tnum shrink-0 text-dim">{p.credits !== null ? `${(p.credits ?? 0) * p.quantity} c` : '?'}{p.points ? ` + ${(p.points ?? 0) * p.quantity} p` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {blockedLines.length > 0 && (
                    <div>
                      <Eyebrow>Sem compra</Eyebrow>
                      <ul className="mt-1.5 max-h-32 overflow-y-auto font-mono text-[11px] text-dim">
                        {blockedLines.map((p) => <li key={`${p.kind}:${p.type}`} className="truncate py-0.5">{p.needed}× {p.name ?? '#' + p.type} — {p.blocked}</li>)}
                      </ul>
                    </div>
                  )}
                  {engine.phase === 'preview' && (
                    <div className="flex flex-wrap items-center gap-2 pt-2">
                      <Button variant="primary" size="lg" onClick={() => session.confirm()} title="Compra o que está na lista e cola o quarto">{buyLines.length ? `Comprar (${plan.totalCredits} c) e colar` : 'Colar'}</Button>
                      <Button onClick={() => session.cancel()}>Cancelar</Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[12.5px] text-fg-2"><LiveDot size={6} />{engine.status || 'lendo inventário e catálogo…'}</div>
              )}
            </Pane>
          )}

          {step === 4 && (
            <Pane title={PHASE_LABEL[engine.phase]} hint="Cada passo espera a confirmação do servidor. Fechar esta tela não interrompe; só o Cancelar para.">
              <div className="flex flex-col gap-3">
                <div className="text-[13px] text-fg-2">{engine.status}</div>
                {engine.progress.total > 0 && (
                  <div className="flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fg/[0.06]"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
                    <span className="tnum shrink-0 font-mono text-[11.5px] text-dim">{engine.progress.done}/{engine.progress.total} · {pct}%</span>
                  </div>
                )}
                <ReportChips engine={engine} />
              </div>
            </Pane>
          )}

          {step === 5 && (
            <Pane title={engine.phase === 'done' ? 'Concluído' : engine.phase === 'error' ? 'Terminou com erro' : 'Cancelado'} hint={engine.status}>
              <div className="flex flex-col gap-4">
                <ReportChips engine={engine} />
                {audit && copy ? (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col gap-0.5">
                        <Eyebrow>Conferência por coordenada</Eyebrow>
                        <span className="text-[11.5px] leading-relaxed text-dim">Percorre o JSON mobi por mobi e confere, em cada casa, se o mobi certo está lá com a altura, a rotação e o estado do original. Um mobi que nunca chegou a ser colocado também aparece aqui.</span>
                      </div>
                      <Button size="sm" onClick={exportAudit} title="Baixa a lista completa de divergências, com as coordenadas">Exportar conferência</Button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Chip tone={auditIsClean(audit) ? 'success' : 'neutral'}>{audit.ok} conferem</Chip>
                      {audit.missing > 0 && <Chip tone="danger" title="A casa está vazia: o mobi não foi colocado. Rode a colagem de novo com “Continuar construção” para colocá-los.">{audit.missing} faltam colocar</Chip>}
                      {audit.wrongType > 0 && <Chip tone="danger" title="A casa tem outro mobi no lugar do que o JSON pede.">{audit.wrongType} tipo errado</Chip>}
                      {audit.fixable > 0 && <Chip tone="warn" title="Casa, altura, rotação ou estado diferentes — um mover ou um usar resolve.">{audit.fixable} fora do lugar</Chip>}
                      {audit.stateNotCheckable > 0 && <Chip tone="info" title="O estado difere, mas o protocolo não deixa ajustar (dados não numéricos: placares, wireds…).">{audit.stateNotCheckable} estado não ajustável</Chip>}
                      {audit.extraFloor + audit.extraWall > 0 && <Chip title="Mobis no quarto que o JSON não pede: mobília sua ou sobra de casa de apoio. Não são tocados.">{audit.extraFloor + audit.extraWall} sobrando</Chip>}
                    </div>
                    {auditProblems.length === 0 ? (
                      <p className="text-success">Cada mobi do JSON está na sua casa, altura, rotação e estado.</p>
                    ) : (
                      <ul className="max-h-56 overflow-y-auto font-mono text-[11px]">
                        {auditProblems.slice(0, 200).map((r, i) => <li key={i} className="truncate py-0.5 text-fg-2" title={r.detail}><span className="text-dim">[{r.verdicts.join(',')}]</span> {r.detail}</li>)}
                        {auditProblems.length > 200 && <li className="text-dim">…e mais {auditProblems.length - 200}. Exporte para ver tudo.</li>}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-dim">Sem conferência nesta execução.</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="primary" onClick={() => setManualStep(2)} disabled={!copy} title="Com “Continuar construção” ligado, só o que falta entra na fila">Rodar de novo com o mesmo JSON</Button>
                  <Button onClick={() => setManualStep(1)}>Outro arquivo</Button>
                </div>
              </div>
            </Pane>
          )}
        </div>

        {/* Opções: sempre visíveis, travadas enquanto roda */}
        <div className={cx('flex min-h-0 flex-col overflow-y-auto', busy && 'opacity-60')}>
          <div className="flex h-11 shrink-0 items-center border-b border-line px-4"><Eyebrow>Opções</Eyebrow>{busy && <span className="ml-auto text-[10.5px] text-dim">travadas enquanto roda</span>}</div>
          <OptRow label="Continuar construção" hint="confere o quarto antes de comprar e só faz o que falta; nada que já está no quarto é movido nem recolhido" checked={options.resume} disabled={busy} onChange={(v) => setOptions((o) => ({ ...o, resume: v }))} />
          <OptRow label="Aplicar a planta" hint={`planta de obra ${BUILD_FLOOR.size}×${BUILD_FLOOR.size} em 0 antes dos mobis (porta em ${BUILD_FLOOR.door.x},${BUILD_FLOOR.door.y}, parede ${BUILD_FLOOR.wallHeight}); a planta real do JSON no fim`} checked={options.applyFloorPlan} disabled={busy} onChange={(v) => setOptions((o) => ({ ...o, applyFloorPlan: v }))} />
          <OptRow label="Comprar o que faltar" hint="só o que não houver no inventário; nada antes da confirmação" checked={options.buyMissing} disabled={busy} onChange={(v) => setOptions((o) => ({ ...o, buyMissing: v }))} />
          <OptRow label="Colocar os mobis" hint="em ordem de altura; estado armado com :state, altura e rotação num só mover com :up; verificação geral no fim" checked={options.placeItems} disabled={busy} onChange={(v) => setOptions((o) => ({ ...o, placeItems: v }))} />
          <OptRow label="Aplicar pintura" hint="piso, papel de parede e paisagem, se houver o item no inventário" checked={options.applyPaint} disabled={busy} onChange={(v) => setOptions((o) => ({ ...o, applyPaint: v }))} />
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
            <div className="flex items-center justify-between"><span className="text-[12.5px] font-medium text-fg-2">Ignorar mobis</span><span className="text-[10.5px] text-dim">prefixo, classe ou id do tipo</span></div>
            <div className="flex flex-wrap items-center gap-1.5">
              {options.ignore.map((p) => (
                <Button key={p} size="sm" disabled={busy} onClick={() => setOptions((o) => ({ ...o, ignore: o.ignore.filter((x) => x !== p) }))} title="Remover da lista">{p} ×</Button>
              ))}
              <Input mono size="sm" value={ignoreDraft} disabled={busy} onChange={(e) => setIgnoreDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addIgnore(ignoreDraft); }} placeholder="wf_, chair_plasto…" className="w-36" />
              <Button size="sm" disabled={busy} onClick={() => addIgnore(ignoreDraft)}>+</Button>
              {!options.ignore.includes('wf_') && <Button size="sm" variant="ghost" disabled={busy} onClick={() => addIgnore('wf_')} title="Ignora todos os wireds (classes wf_*)">+ wireds</Button>}
            </div>
          </div>
          <div className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between"><span className="text-[12.5px] font-medium text-fg-2">Ritmo</span><span className="text-[10.5px] text-dim">{PASTE_PACES.find((p) => p.paceMs === options.paceMs)?.hint ?? 'respiro entre passos confirmados'}</span></div>
            <SegmentedTabs value={String(options.paceMs)} onChange={(v) => { if (!busy) setOptions((o) => ({ ...o, paceMs: parseInt(v, 10) })); }} items={PASTE_PACES.map((p) => ({ value: String(p.paceMs), label: p.label, title: p.hint }))} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Pane({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-[18px] font-semibold tracking-tight text-fg">{title}</h3>
        {hint && <p className="text-[12px] leading-relaxed text-dim">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, tone = 'text-fg', hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-fg/[0.03] px-4 py-3.5" title={hint}>
      <span className="text-[11px] text-dim">{label}</span>
      <span className={cx('tnum font-display text-[26px] font-semibold leading-none', tone)}>{value}</span>
      {hint && <span className="text-[10.5px] text-dim">{hint}</span>}
    </div>
  );
}

function OptRow({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
        <span className="text-[11px] leading-snug text-dim">{hint}</span>
      </div>
      <div className={cx(disabled && 'pointer-events-none')}><Switch checked={checked} onChange={onChange} /></div>
    </div>
  );
}

function ReportChips({ engine }: { engine: typeof pasteSession.engine }) {
  const r = engine.report;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip tone="success">{r.placedFloor} chão</Chip>
      <Chip tone="success">{r.placedWall} parede</Chip>
      {r.purchased > 0 && <Chip tone="info">{r.purchased} compra(s)</Chip>}
      {r.purchaseFailed > 0 && <Chip tone="danger">{r.purchaseFailed} compra(s) falharam</Chip>}
      {r.resumedFloor + r.resumedWall > 0 && <Chip tone="accent">{r.resumedFloor + r.resumedWall} já estavam no quarto</Chip>}
      {r.fixedOnPlace > 0 && <Chip>{r.fixedOnPlace} ajustados ao colocar</Chip>}
      {r.staged > 0 && <Chip tone="info">{r.staged} via casa de apoio</Chip>}
      {r.fixedOnVerify > 0 && <Chip>{r.fixedOnVerify} na verificação</Chip>}
      {r.fixedOnFinal > 0 && <Chip tone="info" title="Consertados no refino, depois da planta final: é a passada que pega o que a troca de piso desarrumou.">{r.fixedOnFinal} no refino</Chip>}
      {r.stillWrong > 0 && <Chip tone="danger" title={`Continuaram com altura, rotação ou estado diferentes após ${MAX_FIX_ATTEMPTS} tentativas. O log diz quais.`}>{r.stillWrong} ainda diferentes</Chip>}
      {r.missingFloor + r.missingWall > 0 && <Chip tone="warn">{r.missingFloor + r.missingWall} sem mobi</Chip>}
      {r.failed > 0 && <Chip tone="danger">{r.failed} falhas</Chip>}
      {r.ignored > 0 && <Chip>{r.ignored} ignorados</Chip>}
      {r.typeMismatch > 0 && <Chip tone="danger">{r.typeMismatch} tipo trocado</Chip>}
      {r.lostOnFloorPlan > 0 && <Chip tone="danger">{r.lostOnFloorPlan} sumiram na planta final</Chip>}
      {r.movedOnFloorPlan > 0 && <Chip tone="warn">{r.movedOnFloorPlan} mudaram na planta final</Chip>}
    </div>
  );
}
