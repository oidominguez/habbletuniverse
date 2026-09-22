/**
 * Cartão "Colar quarto" da aba Jogo: carrega um JSON do "Copiar quarto", mostra a prévia (o que vem do
 * inventário, o que será comprado e por quanto, o que não está à venda) e roda o RoomPasteEngine com
 * confirmação explícita antes de qualquer compra.
 */
import { useRef, useState, useSyncExternalStore } from 'react';
import type { RoomCopy } from '../protocol/roomCopy';
import { BUILD_FLOOR, MAX_FIX_ATTEMPTS, MAX_PURCHASE_QTY, PASTE_PACES, auditIsClean, auditReportText, isIgnored, purchaseCalls } from '../protocol/roomPaste';
import type { PasteOptions, PastePhase } from '../protocol/roomPaste';
import type { GameSnapshot } from '../protocol/state/GameState';
import { pasteSession } from './pasteSession';
import { Switch } from './ConfigInputs';
import { Button, Card, Chip, Eyebrow, Input, SegmentedTabs, SettingRow, Toolbar } from './ui';
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

function isRoomCopy(v: unknown): v is RoomCopy {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<RoomCopy>;
  return typeof c.version === 'number' && Array.isArray(c.floorItems) && Array.isArray(c.wallItems) && Array.isArray(c.shopping) && !!c.room;
}

export default function RoomPaste({ game, agentReady, showToast, onClose }: RoomPasteProps) {
  // A sessão (motor, JSON, opções, relógio) vive fora do React: fechar o cartão não interrompe a colagem.
  const session = pasteSession;
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  const { engine, copy, fileName, options } = session;
  const [ignoreDraft, setIgnoreDraft] = useState('');
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
        showToast('Este arquivo não é uma cópia de quarto do Habblet AddAll');
        return;
      }
      session.setCopy(parsed, file.name);
    } catch (e) {
      showToast('Não deu para ler o arquivo: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const prepare = () => {
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-[11px]">
      <Card
        title="Colar quarto"
        description="Reproduz num quarto SEU um JSON gerado pelo Copiar quarto: planta, pintura, mobis com posição, altura, direção e estado. Compra no catálogo o que faltar no inventário, só depois da sua confirmação."
        actions={<Button size="sm" variant="ghost" onClick={onClose} title={engine.active ? 'A colagem continua em segundo plano; reabra o cartão para acompanhar' : undefined}>fechar</Button>}
      >
        <Toolbar>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = ''; }} />
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>Escolher arquivo…</Button>
          <span className="min-w-0 truncate text-dim">{fileName || 'nenhum arquivo carregado'}</span>
        </Toolbar>
        {copy && (
          <div className="mt-2 space-y-1 text-fg-2">
            <div>
              <span className="text-fg">{cleanName(copy.room.name) || '#' + copy.room.id}</span>
              {copy.room.ownerName && <span className="text-dim"> · de {copy.room.ownerName}</span>}
              <span className="text-dim"> · copiado em {new Date(copy.capturedAt).toLocaleString('pt-BR')}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              <Chip>{copy.summary.floorItems} mobis de chão</Chip>
              <Chip>{copy.summary.wallItems} de parede</Chip>
              <Chip>{copy.summary.types} tipos</Chip>
              {copy.floorPlan ? <Chip tone="info">planta {copy.floorPlan.width}×{copy.floorPlan.height}</Chip> : <Chip tone="warn">sem planta</Chip>}
              {copy.summary.notPurchasable > 0 && <Chip tone="warn">{copy.summary.notPurchasable} sem oferta</Chip>}
              {ignoredCount > 0 && <Chip tone="neutral">{ignoredCount} ignorado(s)</Chip>}
            </div>
          </div>
        )}
      </Card>

      {copy && (
        <Card title="Opções">
          <div className="divide-y divide-line/60">
            <SettingRow
              label="Continuar construção"
              hint="Se a colagem foi interrompida (queda de sessão, de energia, cancelamento), suba o mesmo JSON de novo com isto ligado: antes de comprar qualquer coisa o app confere o que já está no quarto, não recompra nem recoloca nada disso, e só faz o que falta — no fim, a verificação acerta altura, rotação e estado de tudo, inclusive do que já estava lá. Quarto vazio: não muda nada. Quarto pronto: vira só uma conferência. Nada que já está no quarto é movido de casa nem recolhido."
              control={<Switch checked={options.resume} onChange={(v) => setOptions((o) => ({ ...o, resume: v }))} />}
            />
            <SettingRow label="Aplicar a planta" hint={`Antes dos mobis, uma planta de obra: o piso padrão ${BUILD_FLOOR.size}×${BUILD_FLOOR.size} todo em 0 (toda coordenada existe; muita gente tira o piso depois de decorar), porta em ${BUILD_FLOOR.door.x},${BUILD_FLOOR.door.y} e parede ${BUILD_FLOOR.wallHeight}. A planta real do JSON só é salva no fim, com tudo no lugar. O servidor recarrega o quarto nas duas vezes.`} control={<Switch checked={options.applyFloorPlan} onChange={(v) => setOptions((o) => ({ ...o, applyFloorPlan: v }))} />} />
            <SettingRow label="Comprar o que faltar" hint="Só o que não houver no inventário; nada é comprado antes da confirmação." control={<Switch checked={options.buyMissing} onChange={(v) => setOptions((o) => ({ ...o, buyMissing: v }))} />} />
            <SettingRow label="Colocar os mobis" hint="Em ordem de altura. O estado vai armado com :state antes de colocar (só vale na colocação); altura e rotação são acertadas num só mover com :up; estado que ainda vier errado é corrigido usando o mobi (duplo clique). No fim, verificação geral." control={<Switch checked={options.placeItems} onChange={(v) => setOptions((o) => ({ ...o, placeItems: v }))} />} />
            <SettingRow label="Aplicar pintura" hint="Piso, papel de parede e paisagem, se houver o item no inventário." control={<Switch checked={options.applyPaint} onChange={(v) => setOptions((o) => ({ ...o, applyPaint: v }))} />} />
            <SettingRow
              label="Ignorar mobis"
              hint="Prefixo ou nome da classe (wf_ = todos os wireds), ou id do tipo. Não são comprados nem colocados."
              control={
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {options.ignore.map((p) => (
                    <Button key={p} size="sm" onClick={() => setOptions((o) => ({ ...o, ignore: o.ignore.filter((x) => x !== p) }))} title="Remover da lista">{p} ×</Button>
                  ))}
                  <Input mono size="sm" value={ignoreDraft} onChange={(e) => setIgnoreDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addIgnore(ignoreDraft); }} placeholder="wf_, chair_plasto…" className="w-36" />
                  <Button size="sm" onClick={() => addIgnore(ignoreDraft)}>+</Button>
                  {!options.ignore.includes('wf_') && <Button size="sm" variant="ghost" onClick={() => addIgnore('wf_')} title="Ignora todos os wireds (classes wf_*)">+ wireds</Button>}
                </div>
              }
            />
            <SettingRow
              label="Ritmo"
              hint={PASTE_PACES.find((p) => p.paceMs === options.paceMs)?.hint ?? 'cada passo espera a confirmação do servidor; este é só o respiro entre eles'}
              control={<SegmentedTabs value={String(options.paceMs)} onChange={(v) => setOptions((o) => ({ ...o, paceMs: parseInt(v, 10) }))} items={PASTE_PACES.map((p) => ({ value: String(p.paceMs), label: p.label, title: p.hint }))} />}
            />
          </div>
          <Toolbar className="mt-2">
            <Button variant="primary" onClick={prepare} disabled={!canPrepare} title={game.room.id === null ? 'Entre no seu quarto de destino' : !game.room.isOwner ? 'O servidor não confirmou que o quarto é seu (339)' : 'Lê inventário e catálogo e mostra a prévia com o custo'}>Preparar prévia</Button>
            {!game.room.isOwner && game.room.id !== null && <span className="text-warn">este quarto não parece ser seu</span>}
            {engine.active && <Button variant="danger" onClick={() => session.cancel()}>Cancelar</Button>}
          </Toolbar>
        </Card>
      )}

      {engine.phase !== 'idle' && (
        <Card title={`Andamento · ${PHASE_LABEL[engine.phase]}`}>
          <div className="text-fg-2">{engine.status}</div>
          {engine.progress.total > 0 && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-raised">
              <div className="h-full bg-accent transition-all" style={{ width: `${Math.min(100, Math.round((engine.progress.done / engine.progress.total) * 100))}%` }} />
            </div>
          )}
          {plan && (engine.phase === 'preview' || busy) && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-1">
                {engine.report.resumedFloor + engine.report.resumedWall > 0 && (
                  <Chip tone="accent" title="Já estão no quarto: não serão comprados nem colocados de novo; a verificação final acerta altura, rotação e estado.">
                    {engine.report.resumedFloor + engine.report.resumedWall} já no quarto
                  </Chip>
                )}
                {engine.report.strays > 0 && (
                  <Chip tone="warn" title="Mobis do mesmo tipo que estão no quarto fora de qualquer posição do JSON: sobra de uma interrupção no meio de um movimento, ou mobília que já era sua. Ficam onde estão.">
                    {engine.report.strays} fora do JSON
                  </Chip>
                )}
                <Chip tone="success">{plan.fromInventory} do inventário</Chip>
                <Chip tone="info" title={`Máximo de ${MAX_PURCHASE_QTY} unidades por compra; acima disso a mesma oferta é comprada em partes`}>{buyLines.reduce((n, p) => n + p.quantity, 0)} un. em {purchaseCalls(buyLines)} compra(s)</Chip>
                <Chip tone="warn">{plan.totalCredits} créditos</Chip>
                {plan.totalPoints > 0 && <Chip tone="warn">{plan.totalPoints} pontos</Chip>}
                {plan.unpurchasable > 0 && <Chip tone="danger">{plan.unpurchasable} sem oferta</Chip>}
                {plan.floorPlanChanges && <Chip tone="info">planta muda</Chip>}
              </div>
              {buyLines.length > 0 && (
                <div>
                  <Eyebrow>Compras</Eyebrow>
                  <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-[10px]">
                    {buyLines.map((p) => (
                      <li key={`${p.kind}:${p.type}`} className="flex gap-2 truncate">
                        <span className="w-8 shrink-0 text-right tnum" title={p.quantity > MAX_PURCHASE_QTY ? `${Math.ceil(p.quantity / MAX_PURCHASE_QTY)} compras de até ${MAX_PURCHASE_QTY}` : undefined}>{p.quantity}×</span>
                        <span className="min-w-0 flex-1 truncate">{p.name ?? '#' + p.type}{p.unitsPerOffer > 1 ? ` (pacote de ${p.unitsPerOffer})` : ''}</span>
                        <span className="tnum shrink-0 text-dim">{p.credits !== null ? `${(p.credits ?? 0) * p.quantity} c` : '?'}{p.points ? ` + ${(p.points ?? 0) * p.quantity} p` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {blockedLines.length > 0 && (
                <div>
                  <Eyebrow>Sem compra</Eyebrow>
                  <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] text-dim">
                    {blockedLines.map((p) => (
                      <li key={`${p.kind}:${p.type}`} className="truncate">{p.needed}× {p.name ?? '#' + p.type} — {p.blocked}</li>
                    ))}
                  </ul>
                </div>
              )}
              {engine.phase === 'preview' && (
                <Toolbar>
                  <Button variant="primary" onClick={() => session.confirm()} title="Compra o que está na lista e cola o quarto">{buyLines.length ? `Comprar (${plan.totalCredits} c) e colar` : 'Colar'}</Button>
                  <Button onClick={() => session.cancel()}>Cancelar</Button>
                </Toolbar>
              )}
            </div>
          )}
          {engine.phase === 'done' && (
            <div className="mt-2 flex flex-wrap gap-1">
              <Chip tone="success">{engine.report.placedFloor} chão</Chip>
              <Chip tone="success">{engine.report.placedWall} parede</Chip>
              {engine.report.resumedFloor + engine.report.resumedWall > 0 && <Chip tone="accent">{engine.report.resumedFloor + engine.report.resumedWall} já estavam no quarto</Chip>}
              <Chip>{engine.report.fixedOnPlace} ajustados ao colocar</Chip>
              {engine.report.staged > 0 && <Chip tone="info">{engine.report.staged} via casa de apoio</Chip>}
              {engine.report.fixedOnVerify > 0 && <Chip>{engine.report.fixedOnVerify} na verificação</Chip>}
              {engine.report.fixedOnFinal > 0 && <Chip tone="info" title="Consertados no refino, depois da planta final: é a passada que pega o que a troca de piso desarrumou.">{engine.report.fixedOnFinal} no refino</Chip>}
              {engine.report.stillWrong > 0 && <Chip tone="danger" title={`Continuaram com altura, rotação ou estado diferentes após ${MAX_FIX_ATTEMPTS} tentativas. O log diz quais.`}>{engine.report.stillWrong} ainda diferentes</Chip>}
              {engine.report.missingFloor + engine.report.missingWall > 0 && <Chip tone="warn">{engine.report.missingFloor + engine.report.missingWall} sem mobi</Chip>}
              {engine.report.failed > 0 && <Chip tone="danger">{engine.report.failed} falhas</Chip>}
              {engine.report.ignored > 0 && <Chip>{engine.report.ignored} ignorados</Chip>}
              {engine.report.typeMismatch > 0 && <Chip tone="danger">{engine.report.typeMismatch} tipo trocado</Chip>}
              {engine.report.lostOnFloorPlan > 0 && <Chip tone="danger">{engine.report.lostOnFloorPlan} sumiram na planta final</Chip>}
              {engine.report.movedOnFloorPlan > 0 && <Chip tone="warn">{engine.report.movedOnFloorPlan} mudaram na planta final</Chip>}
            </div>
          )}
        </Card>
      )}

      {audit && copy && (
        <Card
          title="Conferência por coordenada"
          description="Percorre o JSON mobi por mobi e confere, em cada casa, se o mobi certo está lá com a altura, a rotação e o estado do original. É a fonte da verdade do resultado: diferente das outras contagens, um mobi que nunca chegou a ser colocado também aparece aqui."
          actions={<Button size="sm" onClick={exportAudit} title="Baixa a lista completa de divergências, com as coordenadas">Exportar conferência</Button>}
        >
          <div className="flex flex-wrap gap-1">
            <Chip tone={auditIsClean(audit) ? 'success' : 'neutral'}>{audit.ok} conferem</Chip>
            {audit.missing > 0 && <Chip tone="danger" title="A casa está vazia: o mobi não foi colocado. Rode a colagem de novo com “Continuar construção” para colocá-los.">{audit.missing} faltam colocar</Chip>}
            {audit.wrongType > 0 && <Chip tone="danger" title="A casa tem outro mobi no lugar do que o JSON pede.">{audit.wrongType} tipo errado</Chip>}
            {audit.fixable > 0 && <Chip tone="warn" title="Casa, altura, rotação ou estado diferentes — um mover ou um usar resolve.">{audit.fixable} fora do lugar</Chip>}
            {audit.stateNotCheckable > 0 && <Chip tone="info" title="O estado difere, mas o protocolo não deixa ajustar (dados não numéricos: placares, wireds…).">{audit.stateNotCheckable} estado não ajustável</Chip>}
            {audit.extraFloor + audit.extraWall > 0 && <Chip title="Mobis no quarto que o JSON não pede: mobília sua ou sobra de casa de apoio. Não são tocados.">{audit.extraFloor + audit.extraWall} sobrando</Chip>}
          </div>
          {auditProblems.length === 0 ? (
            <p className="mt-2 text-success">Cada mobi do JSON está na sua casa, altura, rotação e estado.</p>
          ) : (
            <ul className="mt-2 max-h-48 overflow-y-auto font-mono text-[10px]">
              {auditProblems.slice(0, 200).map((r, i) => (
                <li key={i} className="truncate text-fg-2" title={r.detail}>
                  <span className="text-dim">[{r.verdicts.join(',')}]</span> {r.detail}
                </li>
              ))}
              {auditProblems.length > 200 && <li className="text-dim">…e mais {auditProblems.length - 200}. Exporte para ver tudo.</li>}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
