/**
 * "Colar quarto": reproduz num quarto SEU o JSON gerado pelo "Copiar quarto" — planta, pintura, mobis de chão
 * (posição, direção, altura, estado) e de parede — comprando no catálogo o que faltar no inventário.
 *
 * Máquina de estados dirigida por `tick(now, snapshot)`: cada passo manda um pacote e espera a confirmação do
 * servidor aparecer no GameState (item no quarto, compra aceita, inventário carregado…), com prazo. Assim o
 * ritmo é o do servidor, não o nosso, e nada roda às cegas. Puro: sem React, sem Electron; testável com relógio manual.
 *
 * Fatos do protocolo (sessão de marcadores de 21/09/2026, quarto da conta Dominguez):
 *  - colocar = 1258 ("id x y dir" / "id :w=… "), servidor responde 1534 / 2187 — e o servidor nem sempre respeita a rotação
 *    e o estado pedidos, por isso cada mobi é conferido assim que aparece e corrigido num único movimento (248) com os
 *    modos `:up`/`:state` ligados antes e desligados depois, antes do mobi seguinte; no fim, uma verificação geral refaz
 *    o que ainda estiver diferente;
 *  - altura exata: o comando de chat `:up N` fica ligado e o próximo 248 (mover) põe o mobi na altura N; `:up` desliga;
 *  - estado exato: `:state N` + 248, do mesmo jeito; "usar" (99 / 210) avança um estado por vez;
 *  - comprar = 3492 (página, oferta, dado extra, quantidade); a página vem do índice 1032, a oferta do furnidata;
 *  - planta = 875; o servidor manda reentrar no quarto (160 → 2312) e o 1778 chega de novo;
 *  - pintura = 711 com o id de um item de piso/papel/paisagem do inventário cujo estado é o padrão desejado.
 */
import type { FurniCatalog, WallCatalog } from '../../shared/furnidata';
import { furniFootprint } from '../../shared/furnidata';
import { floorPlanHeight } from './nitro/parsers';
import { EventCursor } from '../addons/protocol/engines';
import type { GameActions } from './actions';
import type { CatalogOffer, FloorItem, InventoryItem, WallItem } from './nitro/parsers';
import { shoppingFor } from './roomCopy';
import type { RoomCopy, RoomCopyFloorItem, RoomCopyWallItem } from './roomCopy';
import type { GameSnapshot } from './state/GameState';

export interface PasteOptions {
  applyFloorPlan: boolean;
  buyMissing: boolean;
  applyPaint: boolean;
  placeItems: boolean;
  /** Pausa entre colocações (ms). */
  paceMs: number;
  /**
   * Mobis a ignorar (não comprar, não colocar): prefixo ou nome exato da classe do furnidata (`wf_` pega todos os
   * wireds, `chair_plasto` só essa cadeira) ou o id numérico do tipo. Sem distinção de maiúsculas.
   */
  ignore: string[];
  /**
   * Continuar uma construção interrompida (queda de sessão, de energia, cancelamento): antes de comprar
   * qualquer coisa, confere o que do JSON já está no quarto e refaz o plano só com o que falta. O quarto é
   * o registro do progresso — nada é guardado em disco, basta subir o mesmo JSON de novo. Com o quarto
   * vazio não muda nada; com o quarto pronto, vira uma passada de conferência e conserto.
   */
  resume: boolean;
}

/** O mobi casa com algum padrão da lista de ignorados? */
export function isIgnored(ignore: readonly string[], type: number, name: string | null): boolean {
  const n = (name ?? '').toLowerCase();
  for (const raw of ignore) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (/^\d+$/.test(p)) {
      if (parseInt(p, 10) === type) return true;
    } else if (n && (n === p || n.startsWith(p))) return true;
  }
  return false;
}

/** Cópia sem os mobis ignorados (lista de compras refeita). */
export function withoutIgnored(copy: RoomCopy, ignore: readonly string[]): { copy: RoomCopy; ignored: number } {
  if (ignore.length === 0) return { copy, ignored: 0 };
  const floorItems = copy.floorItems.filter((it) => !isIgnored(ignore, it.type, it.name));
  const wallItems = copy.wallItems.filter((it) => !isIgnored(ignore, it.type, it.name));
  const shopping = copy.shopping.filter((l) => !isIgnored(ignore, l.type, l.name));
  return { copy: { ...copy, floorItems, wallItems, shopping }, ignored: copy.floorItems.length - floorItems.length + (copy.wallItems.length - wallItems.length) };
}

export const DEFAULT_PASTE_OPTIONS: PasteOptions = { applyFloorPlan: true, buyMissing: true, applyPaint: true, placeItems: true, paceMs: 250, ignore: [], resume: true };

/* ------------------------------ continuar uma construção interrompida ------------------------------ */

/** Um mobi do JSON encontrado no quarto. `itemId` é o id no QUARTO de destino, não o do JSON. */
export interface PlacedFloorMatch {
  want: RoomCopyFloorItem;
  itemId: number;
}

export interface PlacedWallMatch {
  want: RoomCopyWallItem;
  itemId: string;
}

export interface PlacedMatch {
  floorMatched: PlacedFloorMatch[];
  floorMissing: RoomCopyFloorItem[];
  wallMatched: PlacedWallMatch[];
  wallMissing: RoomCopyWallItem[];
  /**
   * Mobis do quarto de um tipo que o JSON usa e que não casaram com nenhuma posição dele: sobra de uma
   * interrupção no meio de um movimento (o mobi ficou na casa de apoio) ou mobília que já era do quarto.
   * Só informativo — nada é movido nem recolhido.
   */
  strays: number;
}

/** Posição de parede como chave: o cliente manda com um espaço no fim, o servidor devolve sem. */
function wallKey(spriteId: number, position: string): string {
  return `${spriteId}|${position.trim()}`;
}

/**
 * Reconcilia o JSON com o que já está no quarto ("continuar construção"). Um mobi do JSON conta como feito
 * quando existe no quarto um do MESMO TIPO na MESMA CASA (parede: mesma posição); numa pilha de mobis iguais
 * na mesma casa, casa primeiro o de altura mais próxima. Altura, rotação e estado diferentes NÃO impedem o
 * casamento: o mobi já existe, e a verificação final o acerta sem comprar outro.
 *
 * Conservador de propósito: nada que já está no quarto é movido, recolhido ou reaproveitado. Um mobi que a
 * interrupção deixou numa casa de apoio não casa com nada, entra em `strays` e o motor coloca outro no
 * destino — melhor pagar um mobi a mais do que mexer na mobília de alguém.
 */
/**
 * REGRA ÚNICA de casamento JSON × quarto, usada pela retomada e pela conferência por coordenada — para as
 * duas nunca discordarem. Cada mobi do JSON procura no quarto um do mesmo tipo NA MESMA CASA (parede: na
 * mesma posição); numa pilha de mobis iguais, o de altura mais próxima. Cada mobi do quarto casa com no
 * máximo um item do JSON: o que sobra fica em `leftoverFloor` / `leftoverWall`.
 */
export interface RoomMatch {
  floor: { want: RoomCopyFloorItem; found: FloorItem | null }[];
  wall: { want: RoomCopyWallItem; found: WallItem | null }[];
  leftoverFloor: FloorItem[];
  leftoverWall: WallItem[];
}

export function matchRoomItems(copy: RoomCopy, snapshot: GameSnapshot): RoomMatch {
  const byTile = new Map<string, FloorItem[]>();
  for (const it of snapshot.room.floorItems) {
    const key = `${it.spriteId}:${it.x}:${it.y}`;
    const list = byTile.get(key);
    if (list) list.push(it);
    else byTile.set(key, [it]);
  }
  const floor: RoomMatch['floor'] = [];
  for (const want of copy.floorItems) {
    const list = byTile.get(`${want.type}:${want.x}:${want.y}`);
    if (!list || list.length === 0) {
      floor.push({ want, found: null });
      continue;
    }
    // Pilha de mobis iguais na mesma casa: o de altura mais próxima é o que corresponde a este.
    let best = 0;
    for (let i = 1; i < list.length; i++) if (Math.abs(list[i].z - want.z) < Math.abs(list[best].z - want.z)) best = i;
    floor.push({ want, found: list[best] });
    list.splice(best, 1);
  }

  const byWall = new Map<string, WallItem[]>();
  for (const it of snapshot.room.wallItems) {
    const key = wallKey(it.spriteId, it.wallPosition);
    const list = byWall.get(key);
    if (list) list.push(it);
    else byWall.set(key, [it]);
  }
  const wall: RoomMatch['wall'] = [];
  for (const want of copy.wallItems) {
    wall.push({ want, found: byWall.get(wallKey(want.type, want.position))?.shift() ?? null });
  }

  const leftoverFloor: FloorItem[] = [];
  for (const list of byTile.values()) for (const it of list) leftoverFloor.push(it);
  const leftoverWall: WallItem[] = [];
  for (const list of byWall.values()) for (const it of list) leftoverWall.push(it);
  return { floor, wall, leftoverFloor, leftoverWall };
}

export function matchPlaced(copy: RoomCopy, snapshot: GameSnapshot): PlacedMatch {
  const m = matchRoomItems(copy, snapshot);
  const floorMatched: PlacedFloorMatch[] = [];
  const floorMissing: RoomCopyFloorItem[] = [];
  for (const r of m.floor) {
    if (r.found) floorMatched.push({ want: r.want, itemId: r.found.id });
    else floorMissing.push(r.want);
  }
  const wallMatched: PlacedWallMatch[] = [];
  const wallMissing: RoomCopyWallItem[] = [];
  for (const r of m.wall) {
    if (r.found) wallMatched.push({ want: r.want, itemId: r.found.id });
    else wallMissing.push(r.want);
  }
  const types = new Set<number>(copy.floorItems.map((i) => i.type));
  const strays = m.leftoverFloor.filter((it) => types.has(it.spriteId)).length;
  return { floorMatched, floorMissing, wallMatched, wallMissing, strays };
}

/* --------------------------- conferência por coordenada (checkup) --------------------------- */

export type AuditVerdict =
  | 'ok'
  /** Nenhum mobi na casa: não foi colocado (ou foi recolhido). */
  | 'missing'
  /** A casa tem mobi, mas de outro tipo. */
  | 'wrong-type'
  /** O mobi que o motor colocou para este item está em OUTRA casa. */
  | 'wrong-position'
  | 'wrong-z'
  | 'wrong-direction'
  | 'wrong-state'
  /** O estado difere, mas não é ajustável por protocolo (dados não numéricos): fica registrado. */
  | 'state-not-checkable';

/** Veredictos que um mover (248) ou um usar (99/210) resolve. */
export const FIXABLE_VERDICTS: readonly AuditVerdict[] = ['wrong-position', 'wrong-z', 'wrong-direction', 'wrong-state'];

export interface FloorAuditRow {
  want: RoomCopyFloorItem;
  found: FloorItem | null;
  verdicts: AuditVerdict[];
  /** Frase pronta para o log e o relatório. */
  detail: string;
}

export interface WallAuditRow {
  want: RoomCopyWallItem;
  found: WallItem | null;
  verdicts: AuditVerdict[];
  detail: string;
}

export interface RoomAudit {
  floor: FloorAuditRow[];
  wall: WallAuditRow[];
  ok: number;
  /** Casa vazia ou com o tipo errado: falta colocar. */
  missing: number;
  wrongType: number;
  /** Divergências que um mover/usar resolve (altura, rotação, estado, casa). */
  fixable: number;
  /** Estados que o protocolo não deixa ajustar. */
  stateNotCheckable: number;
  /** Mobis no quarto que o JSON não pede (mobília sua, sobra de casa de apoio…). */
  extraFloor: number;
  extraWall: number;
}

export function auditIsClean(a: RoomAudit): boolean {
  return a.missing === 0 && a.wrongType === 0 && a.fixable === 0;
}

function typeLabel(want: RoomCopyFloorItem): string {
  return want.name ?? '#' + want.type;
}

/**
 * Conferência por coordenada: percorre o JSON mobi por mobi e diz, para CADA UM, se está na casa certa,
 * na altura certa, na rotação certa e no estado certo — ou o que está errado.
 *
 * É o inverso do check antigo, que percorria só o que o motor tinha colocado nesta execução: um mobi que
 * nunca foi colocado (inventário esgotado, prazo estourado, execução anterior) não aparecia em lista
 * nenhuma e passava batido. Aqui a fonte da verdade é o JSON, então "faltou colocar em (12, 30)" é um
 * resultado possível.
 *
 * `placedIds` (opcional) liga um item do JSON ao id do mobi que o motor colocou para ele; com esse mapa,
 * um mobi que saiu de lugar é apontado como `wrong-position` (com a casa onde está) em vez de virar
 * "falta um aqui" e "sobra um lá".
 */
export function auditRoom(copy: RoomCopy, snapshot: GameSnapshot, placedIds?: ReadonlyMap<RoomCopyFloorItem, number>): RoomAudit {
  const m = matchRoomItems(copy, snapshot);
  const occupied = new Set<string>();
  for (const it of snapshot.room.floorItems) occupied.add(`${it.x},${it.y}`);
  const leftoverById = new Map(m.leftoverFloor.map((it) => [it.id, it]));

  const floor: FloorAuditRow[] = [];
  let ok = 0;
  let missing = 0;
  let wrongType = 0;
  let fixable = 0;
  let stateNotCheckable = 0;

  for (const r of m.floor) {
    const want = r.want;
    const verdicts: AuditVerdict[] = [];
    let detail = '';
    let found = r.found;

    if (!found) {
      // O mobi que colocamos para este item continua no quarto, só em outra casa?
      const id = placedIds?.get(want);
      const strayed = id !== undefined ? leftoverById.get(id) : undefined;
      if (strayed) {
        leftoverById.delete(strayed.id);
        found = strayed;
        verdicts.push('wrong-position');
        detail = `deveria estar em (${want.x}, ${want.y}) e está em (${strayed.x}, ${strayed.y})`;
      } else if (occupied.has(`${want.x},${want.y}`)) {
        verdicts.push('wrong-type');
        detail = `a casa (${want.x}, ${want.y}) tem outro mobi, não ${typeLabel(want)}`;
      } else {
        verdicts.push('missing');
        detail = `a casa (${want.x}, ${want.y}) está vazia: ${typeLabel(want)} não foi colocado`;
      }
    }

    if (found) {
      const mm = mismatchOf(found, want);
      if (mm.position && !verdicts.includes('wrong-position')) verdicts.push('wrong-position');
      if (mm.z) verdicts.push('wrong-z');
      if (mm.direction) verdicts.push('wrong-direction');
      if (mm.state) verdicts.push('wrong-state');
      if (!stateIsSettable(want) && found.state !== want.state) verdicts.push('state-not-checkable');
      const diff = describeMismatch(mm, found, want);
      if (diff) detail = detail ? `${detail}; ${diff}` : `${typeLabel(want)} em (${want.x}, ${want.y}): ${diff}`;
    }

    if (verdicts.length === 0) {
      verdicts.push('ok');
      detail = `${typeLabel(want)} em (${want.x}, ${want.y}) ok`;
      ok++;
    } else {
      if (verdicts.includes('missing')) missing++;
      else if (verdicts.includes('wrong-type')) wrongType++;
      else if (verdicts.some((v) => FIXABLE_VERDICTS.includes(v))) fixable++;
      if (verdicts.includes('state-not-checkable')) stateNotCheckable++;
    }
    floor.push({ want, found, verdicts, detail });
  }

  const wall: WallAuditRow[] = [];
  for (const r of m.wall) {
    const want = r.want;
    const label = `${want.name ?? '#' + want.type} em ${want.position}`;
    let verdict: AuditVerdict;
    let detail: string;
    if (!r.found) {
      verdict = 'missing';
      detail = `mobi de parede ${label} não foi colocado`;
      missing++;
    } else if (/^-?\d+$/.test(want.state) && r.found.state !== want.state) {
      verdict = 'wrong-state';
      detail = `${label}: estado ${r.found.state} → ${want.state}`;
      fixable++;
    } else {
      verdict = 'ok';
      detail = `${label} ok`;
      ok++;
    }
    wall.push({ want, found: r.found, verdicts: [verdict], detail });
  }

  return { floor, wall, ok, missing, wrongType, fixable, stateNotCheckable, extraFloor: leftoverById.size, extraWall: m.leftoverWall.length };
}

/** Relatório legível da conferência, para o painel e para exportar. */
export function auditReportText(copy: RoomCopy, audit: RoomAudit, now = new Date()): string {
  const lines: string[] = [
    `Conferência por coordenada — ${now.toLocaleString('pt-BR')}`,
    `Quarto de origem: ${copy.room.name ?? '#' + copy.room.id}${copy.room.ownerName ? ` (de ${copy.room.ownerName})` : ''}`,
    `JSON: ${copy.floorItems.length} mobi(s) de chão, ${copy.wallItems.length} de parede`,
    '',
    `ok ${audit.ok} · falta colocar ${audit.missing} · tipo errado ${audit.wrongType} · ajustável ${audit.fixable} · estado não conferível ${audit.stateNotCheckable} · sobrando no quarto ${audit.extraFloor + audit.extraWall}`,
    '',
  ];
  const problems = [...audit.floor, ...audit.wall].filter((r) => !r.verdicts.includes('ok'));
  if (problems.length === 0) {
    lines.push('Nenhuma divergência: cada mobi do JSON está na sua casa, altura, rotação e estado.');
  } else {
    lines.push(`=== ${problems.length} divergência(s) ===`);
    for (const r of problems) lines.push(`[${r.verdicts.join(',')}] ${r.detail}`);
  }
  return lines.join('\n') + '\n';
}

/** Ritmos oferecidos na interface: respiro entre passos já confirmados pelo servidor. */
export const PASTE_PACES: { label: string; paceMs: number; hint: string }[] = [
  { label: 'rápido', paceMs: 120, hint: 'quase sem respiro; o servidor dita o ritmo (cada passo espera a confirmação dele)' },
  { label: 'normal', paceMs: 250, hint: 'padrão' },
  { label: 'seguro', paceMs: 600, hint: 'para quartos gigantes ou se o servidor reclamar de flood' },
];

export type PastePhase = 'idle' | 'loading' | 'pricing' | 'preview' | 'buying' | 'floorplan' | 'placing' | 'verifying' | 'paint' | 'floorplan-final' | 'refining' | 'done' | 'error' | 'cancelled';

export interface PurchaseLine {
  kind: 'floor' | 'wall';
  type: number;
  name: string | null;
  /** Unidades que faltam. */
  needed: number;
  /** `offerid` do furnidata: é a chave que o índice do catálogo (1032) usa para apontar a página. NÃO é o id que se compra. */
  furniOfferId: number;
  /** Oferta da página (804) que entrega este mobi: é este id que vai no 3492. Preenchido ao ler a página. */
  offerId: number;
  pageId: number | null;
  /** Preenchido quando a página chega: preço unitário da oferta e quantas unidades ela entrega. */
  credits: number | null;
  points: number | null;
  pointsType: number | null;
  unitsPerOffer: number;
  extra: string;
  /** Quantas compras (3492) serão feitas. */
  quantity: number;
  /** Motivo de não dar para comprar (sem oferta, fora do índice, página não carregou). */
  blocked: string | null;
}

export interface PastePlan {
  purchases: PurchaseLine[];
  /** Unidades já disponíveis no inventário, por linha da lista de compras. */
  fromInventory: number;
  totalCredits: number;
  totalPoints: number;
  unpurchasable: number;
  floorPlanChanges: boolean;
  paint: { type: string; value: string; itemId: number | null }[];
}

export interface PasteReport {
  placedFloor: number;
  placedWall: number;
  missingFloor: number;
  missingWall: number;
  failed: number;
  /** Mobis que vieram com altura/rotação/estado diferentes e foram corrigidos logo ao serem colocados. */
  fixedOnPlace: number;
  /** Colocados numa casa livre e levados ao destino com `:up` (a casa de destino já tinha mobi, ou a altura não é a do chão). */
  staged: number;
  /** Corrigidos na verificação que roda antes da planta final. */
  fixedOnVerify: number;
  /**
   * Corrigidos na passada de refino, DEPOIS da planta final — é a que pega o que a troca de piso
   * desarrumou (o servidor reassenta os mobis quando a altura do chão muda debaixo deles).
   */
  fixedOnFinal: number;
  /** Mobis que continuaram com casa, altura, rotação ou estado errados depois de todas as tentativas. */
  stillWrong: number;
  /** Conferência final: mobis do JSON que estão certos no quarto. */
  auditOk: number;
  /** Conferência final: mobis do JSON que não estão no quarto (casa vazia ou com outro tipo). */
  auditMissing: number;
  purchased: number;
  purchaseFailed: number;
  /** Mobis do JSON deixados de fora pela lista de ignorados. */
  ignored: number;
  /** Mobis do JSON que já estavam no quarto ao continuar uma construção (não foram comprados nem colocados de novo). */
  resumedFloor: number;
  resumedWall: number;
  /** Mobis do quarto do tipo do JSON fora de qualquer posição dele (sobra de uma interrupção); só informativo. */
  strays: number;
  /** O servidor colocou um tipo diferente do pedido (mobi trocado). */
  typeMismatch: number;
  /** Mobis colocados que sumiram do quarto depois da planta final (o servidor recolheu o que ficou sem chão?). */
  lostOnFloorPlan: number;
  /** Mobis colocados que mudaram de casa ou altura depois da planta final. */
  movedOnFloorPlan: number;
}

export interface PasteTick {
  now: number;
  snapshot: GameSnapshot;
  actions: GameActions;
  catalog: FurniCatalog | null;
  walls: WallCatalog | null;
  log: (msg: string) => void;
}

const LOAD_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 6_000;
const PURCHASE_TIMEOUT_MS = 8_000;
const PURCHASE_GAP_MS = 500;
/** O catálogo aceita no máximo 100 unidades por compra (observado em 21/09/2026); acima disso, compras separadas da mesma oferta. */
export const MAX_PURCHASE_QTY = 100;

/** Divide cada linha em compras de até MAX_PURCHASE_QTY unidades (483 → 100, 100, 100, 100, 83). */
export function splitPurchases(lines: readonly PurchaseLine[]): PurchaseLine[] {
  const out: PurchaseLine[] = [];
  for (const line of lines) {
    let left = line.quantity;
    while (left > 0) {
      const q = Math.min(MAX_PURCHASE_QTY, left);
      out.push({ ...line, quantity: q });
      left -= q;
    }
  }
  return out;
}

/** Quantas chamadas de compra uma lista vai gerar. */
export function purchaseCalls(lines: readonly PurchaseLine[]): number {
  return lines.reduce((n, l) => n + Math.ceil(l.quantity / MAX_PURCHASE_QTY), 0);
}
const FLOORPLAN_TIMEOUT_MS = 20_000;
const PLACE_TIMEOUT_MS = 4_000;
const ADJUST_TIMEOUT_MS = 4_000;
const CHAT_SETTLE_MS = 250;
const MAX_STATE_TOGGLES = 8;
/**
 * Quantas vezes um mesmo mobi é reconsertado numa passada de verificação antes de entrar no relatório
 * como "ainda diferente". O servidor às vezes ignora a rotação pedida num mover e aceita no seguinte.
 */
export const MAX_FIX_ATTEMPTS = 3;

const PAINT_CLASSES = new Set(['floor', 'wallpaper', 'landscape']);

/** Padrão do piso/papel de um item do inventário: fica no estado (ex.: "111"). */
function paintValue(it: InventoryItem): string {
  return it.state.trim();
}

/** Que mobis do inventário servem para o tipo pedido (chão = `S`, parede = `I`). */
function inventoryFor(inv: readonly InventoryItem[], kind: 'floor' | 'wall', type: number): InventoryItem[] {
  return inv.filter((it) => it.spriteId === type && it.type === (kind === 'floor' ? 'S' : 'I'));
}

/** Lista de compras a partir do JSON, do inventário e do índice do catálogo (preços entram depois, com as páginas). */
export function planPurchases(copy: RoomCopy, inventory: readonly InventoryItem[], catalog: FurniCatalog | null, walls: WallCatalog | null, pageForOffer: (offerId: number) => number | null): { purchases: PurchaseLine[]; fromInventory: number } {
  const purchases: PurchaseLine[] = [];
  let fromInventory = 0;
  for (const line of copy.shopping) {
    const have = inventoryFor(inventory, line.kind, line.type).length;
    const used = Math.min(have, line.count);
    fromInventory += used;
    const needed = line.count - used;
    if (needed <= 0) continue;
    const info = line.kind === 'floor' ? catalog?.[line.type] : walls?.[line.type];
    const offerId = info?.offerId ?? line.offerId ?? -1;
    const name = line.name ?? info?.name ?? null;
    const pl: PurchaseLine = { kind: line.kind, type: line.type, name, needed, furniOfferId: offerId ?? -1, offerId: -1, pageId: null, credits: null, points: null, pointsType: null, unitsPerOffer: 1, extra: '', quantity: needed, blocked: null };
    if (offerId === null || offerId < 0) pl.blocked = 'não está à venda no catálogo';
    else {
      pl.pageId = pageForOffer(offerId);
      if (pl.pageId === null) pl.blocked = 'oferta fora do índice do catálogo';
    }
    purchases.push(pl);
  }
  return { purchases, fromInventory };
}

/**
 * Acha na página a oferta que entrega o mobi pedido. O `offerid` do furnidata não é o id da oferta da página
 * (visto em 21/09/2026: furnidata 10002781 × página 4984 para a mesma cadeira), então a busca é pelo produto:
 * tipo (s/i) e spriteId. Entre várias, prefere a que entrega só esse mobi e a mais barata.
 */
export function findOffer(page: { offers: CatalogOffer[] } | undefined, kind: 'floor' | 'wall', spriteId: number): CatalogOffer | undefined {
  if (!page) return undefined;
  const productType = kind === 'floor' ? 's' : 'i';
  const candidates = page.offers.filter((o) => !o.rent && o.products.some((p) => p.type === productType && p.spriteId === spriteId));
  candidates.sort((a, b) => a.products.length - b.products.length || a.credits + a.points - (b.credits + b.points));
  return candidates[0];
}

/** Preenche a oferta da página, preço, dado extra e unidades por oferta; ajusta a quantidade de compras. */
export function priceLine(pl: PurchaseLine, offer: CatalogOffer | undefined, wantedType: 'floor' | 'wall'): void {
  if (!offer) {
    pl.blocked = 'nenhuma oferta na página entrega este mobi';
    return;
  }
  const productType = wantedType === 'floor' ? 's' : 'i';
  const product = offer.products.find((p) => p.type === productType && p.spriteId === pl.type) ?? offer.products.find((p) => p.spriteId === pl.type);
  pl.offerId = offer.offerId;
  pl.credits = offer.credits;
  pl.points = offer.points;
  pl.pointsType = offer.pointsType;
  pl.extra = product?.extra ?? '';
  pl.unitsPerOffer = Math.max(1, product?.count ?? 1);
  pl.quantity = Math.ceil(pl.needed / pl.unitsPerOffer);
  if (offer.rent) pl.blocked = 'oferta é de aluguel';
}

export function planTotals(purchases: readonly PurchaseLine[]): { totalCredits: number; totalPoints: number; unpurchasable: number } {
  let totalCredits = 0;
  let totalPoints = 0;
  let unpurchasable = 0;
  for (const pl of purchases) {
    if (pl.blocked) {
      unpurchasable += pl.needed;
      continue;
    }
    totalCredits += (pl.credits ?? 0) * pl.quantity;
    totalPoints += (pl.points ?? 0) * pl.quantity;
  }
  return { totalCredits, totalPoints, unpurchasable };
}

/** As linhas dadas diferem da planta atual do quarto? */
export function rowsDiffer(rows: string[], snapshot: GameSnapshot): boolean {
  const cur = snapshot.room.floorPlan;
  if (!cur) return true;
  const trim = (rs: string[]) => rs.map((r) => r.replace(/\s+$/, '')).filter((r, i, a) => r.length > 0 || i < a.length - 1);
  return trim(cur.rows).join('\r') !== trim(rows).join('\r');
}

/** A porta do JSON difere da atual? */
export function doorDiffers(copy: RoomCopy, snapshot: GameSnapshot): boolean {
  const door = snapshot.room.door;
  const want = copy.floorPlan?.door;
  return !!(want && door && (door.x !== want.x || door.y !== want.y));
}

/** A planta do JSON difere da atual (linhas ou porta)? */
export function floorPlanDiffers(copy: RoomCopy, snapshot: GameSnapshot): boolean {
  if (!copy.floorPlan) return false;
  return rowsDiffer(copy.floorPlan.rows, snapshot) || doorDiffers(copy, snapshot);
}

/**
 * Piso padrão de obra (enviado pelo usuário em 21/09/2026): 64×64 casas na altura 0 e parede na altura máxima do editor.
 * A parede vai até 15: com 16 o servidor descarta o 875 sem responder nada (visto em 21/09/2026, 02:08); com 9, 3 e 15 confirmou.
 */
export const BUILD_FLOOR = {
  size: 64,
  wallHeight: 15,
  /** Porta (onde o avatar nasce) da planta de obra: canto 63,63, fora do caminho da colagem (pedido do usuário, 21/09/2026). */
  door: { x: 63, y: 63, direction: 2 },
} as const;

/** As linhas do piso padrão: `size` linhas de `size` zeros. */
export function standardFloorRows(size: number = BUILD_FLOOR.size): string[] {
  return Array.from({ length: size }, () => '0'.repeat(size));
}

export interface BuildFloorPlan {
  rows: string[];
  /** Casas de mobi que no JSON não têm chão (ficam abertas na obra e fecham na planta final). */
  opened: number;
  /** Casas de mobi fora do piso padrão: esses mobis não têm onde ficar. */
  outside: number;
  wallHeight: number;
}

/**
 * Planta de obra: exatamente o piso padrão (64 linhas de 64 zeros, toda coordenada existe em altura 0), por
 * decisão do usuário (21/09/2026). Muita gente coloca o mobi e depois tira o piso por baixo no editor; como o
 * servidor recusa colocar onde não há chão, primeiro construímos sobre o piso padrão e só no fim salvamos a
 * planta real. Sobre o piso 0, todo mobi que no JSON está acima de 0 vai pela casa de apoio com `:up z`.
 */
export function buildFloorPlan(copy: RoomCopy, catalog: FurniCatalog | null): BuildFloorPlan | null {
  if (!copy.floorPlan) return null;
  const size = BUILD_FLOOR.size;
  let opened = 0;
  let outside = 0;
  for (const it of copy.floorItems) {
    for (const tl of furniFootprint(it, catalog?.[it.type])) {
      if (tl.x < 0 || tl.y < 0 || tl.x >= size || tl.y >= size) {
        outside++;
        continue;
      }
      if (floorPlanHeight(copy.floorPlan.rows[tl.y]?.[tl.x] ?? 'x') === null) opened++;
    }
  }
  return { rows: standardFloorRows(size), opened, outside, wallHeight: BUILD_FLOOR.wallHeight };
}

interface Placement {
  copyItem: RoomCopyFloorItem;
  itemId: number;
}

interface WallPlacement {
  item: RoomCopyWallItem;
  itemId: string;
}

/** O que está diferente entre o mobi no quarto e o que o JSON pede. */
export interface Mismatch {
  position: boolean;
  z: boolean;
  direction: boolean;
  state: boolean;
}

/** Menor diferença de altura que o jogo distingue (pilhas usam 0.001). */
export const HEIGHT_EPSILON = 0.0005;

function stateIsSettable(want: RoomCopyFloorItem): boolean {
  return want.dataKind === 0 && /^-?\d+$/.test(want.state);
}

export function mismatchOf(cur: FloorItem, want: RoomCopyFloorItem): Mismatch {
  return {
    position: cur.x !== want.x || cur.y !== want.y,
    z: Math.abs(cur.z - want.z) > HEIGHT_EPSILON,
    direction: cur.direction !== want.direction,
    state: stateIsSettable(want) && cur.state !== want.state,
  };
}

function hasMismatch(m: Mismatch): boolean {
  return m.position || m.z || m.direction || m.state;
}

/** Posição, altura ou rotação diferentes: só um mover (248) resolve. Estado não entra: mover não muda estado. */
function needsMove(m: Mismatch): boolean {
  return m.position || m.z || m.direction;
}

function describeMismatch(m: Mismatch, cur: FloorItem, want: RoomCopyFloorItem): string {
  const parts: string[] = [];
  if (m.position) parts.push(`posição (${cur.x}, ${cur.y}) → (${want.x}, ${want.y})`);
  if (m.z) parts.push(`altura ${cur.z} → ${want.z}`);
  if (m.direction) parts.push(`rotação ${cur.direction} → ${want.direction}`);
  if (m.state) parts.push(`estado ${cur.state} → ${want.state}`);
  return parts.join(', ');
}

/**
 * Operações em fila: um comando de chat (com respiro), um movimento verificado ou um "usar" verificado.
 * Regras do servidor (observadas pelo usuário em 21/09/2026): `:up` e `:spin` valem no MOVER; `:state` só vale
 * na COLOCAÇÃO (1258) — mover com `:state` ligado não muda o estado. Por isso o estado vai armado antes de
 * colocar; altura e rotação são acertadas num único 248 com `:up`; e um estado que ainda assim vier errado é
 * corrigido "usando" o mobi (99, o duplo clique) até bater. `final` marca a última operação do mobi, a que
 * conta no relatório.
 */
type Op =
  | { kind: 'chat'; text: string }
  | { kind: 'move'; p: Placement; label: string; final: boolean }
  | { kind: 'floor-use'; p: Placement; final: boolean }
  | { kind: 'wall-use'; w: WallPlacement };

type Step =
  | { kind: 'none' }
  | { kind: 'page'; pageId: number; since: number }
  | { kind: 'purchase'; line: PurchaseLine; since: number; offerId: number }
  | { kind: 'gap'; until: number }
  | { kind: 'inventory'; since: number }
  | { kind: 'floorplan'; rows: string[]; since: number }
  | { kind: 'floorplan-check'; until: number }
  | { kind: 'place-floor'; item: RoomCopyFloorItem; itemId: number; since: number; staged: boolean }
  | { kind: 'place-wall'; item: RoomCopyWallItem; itemId: string; since: number }
  | { kind: 'chat'; until: number }
  | { kind: 'verify-move'; p: Placement; label: string; since: number; final: boolean }
  | { kind: 'floor-state'; p: Placement; toggles: number; since: number; final: boolean }
  | { kind: 'wall-state'; w: WallPlacement; toggles: number; since: number };

export class RoomPasteEngine {
  phase: PastePhase = 'idle';
  status = '';
  plan: PastePlan | null = null;
  report: PasteReport = emptyReport();
  /**
   * Conferência por coordenada mais recente (mobi por mobi do JSON contra o quarto). Refeita a cada
   * passada de conserto e uma última vez no fim; é o que o painel mostra e exporta.
   */
  audit: RoomAudit | null = null;
  /** Progresso da fase atual (para a barra). */
  progress = { done: 0, total: 0 };

  /** O JSON inteiro (menos os ignorados): é ele que manda na planta, na porta e na pintura. */
  private copy: RoomCopy | null = null;
  /**
   * O que ainda falta comprar e colocar. Igual a `copy`, ou só os que faltam quando "continuar construção"
   * encontrou parte do quarto já montada.
   */
  private remaining: RoomCopy | null = null;
  private options: PasteOptions = DEFAULT_PASTE_OPTIONS;
  private cursor = new EventCursor();
  private step: Step = { kind: 'none' };
  private ops: Op[] = [];
  private startedAt = 0;
  private sawInventory = false;
  private pagesToFetch: number[] = [];
  private purchaseQueue: PurchaseLine[] = [];
  private floorQueue: RoomCopyFloorItem[] = [];
  private wallQueue: RoomCopyWallItem[] = [];
  private placements: Placement[] = [];
  private wallPlacements: WallPlacement[] = [];
  private usedInventory = new Set<number>();
  private verifyQueue: Placement[] = [];
  private wallVerifyQueue: WallPlacement[] = [];
  /** Mobi cujo conserto está em andamento: quem falhou, para tentar de novo. */
  private fixing: Placement | null = null;
  private fixingWall: WallPlacement | null = null;
  /** Tentativas de conserto já gastas por mobi, na passada atual. */
  private fixAttempts = new Map<number, number>();
  private wallFixAttempts = new Map<string, number>();
  private buildMode: { up: number | null; state: string | null } = { up: null, state: null };
  private paintQueue: number[] = [];
  private confirmed = false;
  private lastLog = '';
  /** Na verificação final: quantos mobis ainda saíram errados depois da segunda tentativa. */
  private verifyFailures = 0;
  /**
   * `:up N` é relativo ao piso da casa de destino (piso 20 + `:up 6` = 26, relatado pelo usuário em 21/09/2026).
   * Se o servidor se comportar como altura absoluta, o motor percebe no primeiro ajuste que estoura o prazo e troca.
   */
  private upRelative = true;
  private upSemanticsFlips = 0;

  /** Começa: pede inventário e índice do catálogo, monta o plano e para em `preview` até `confirm()`. */
  start(copy: RoomCopy, options: Partial<PasteOptions>, t: PasteTick): void {
    this.reset();
    this.options = { ...DEFAULT_PASTE_OPTIONS, ...options };
    const filtered = withoutIgnored(copy, this.options.ignore);
    this.copy = filtered.copy;
    this.report.ignored = filtered.ignored;
    if (filtered.ignored) t.log(`${filtered.ignored} mobi(s) ignorado(s) pela lista (${this.options.ignore.join(', ')}): não serão comprados nem colocados.`);
    this.startedAt = t.now;
    this.cursor.skipToEnd(t.snapshot);
    if (t.snapshot.room.id === null) {
      this.fail('entre no quarto de destino antes de colar', t.log);
      return;
    }
    if (!t.snapshot.room.isOwner) {
      this.fail('o quarto atual não é seu (o servidor não mandou o 339): só dá para colar num quarto próprio', t.log);
      return;
    }
    this.phase = 'loading';
    this.setStatus('pedindo inventário e índice do catálogo…', t.log);
    t.actions.requestInventory();
    if (!t.snapshot.catalogIndex) t.actions.requestCatalogIndex();
  }

  /** Depois da prévia: autoriza compras e colagem. */
  confirm(): void {
    if (this.phase === 'preview') this.confirmed = true;
  }

  cancel(t: PasteTick): void {
    if (this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled' || this.phase === 'idle') return;
    this.turnOffBuildModes(t);
    this.phase = 'cancelled';
    this.setStatus('cancelado.', t.log);
  }

  get active(): boolean {
    return this.phase !== 'idle' && this.phase !== 'done' && this.phase !== 'error' && this.phase !== 'cancelled';
  }

  tick(t: PasteTick): void {
    if (!this.active || !this.copy) return;
    const { now, snapshot, log } = t;
    for (const ev of this.cursor.take(snapshot)) {
      if (ev.kind === 'inventory') this.sawInventory = true;
      if (ev.kind === 'purchase' && this.step.kind === 'purchase' && ev.offerId === this.step.offerId) {
        this.report.purchased += this.step.line.quantity;
        log(`compra aceita: ${ev.name} ×${this.step.line.quantity}.`);
        this.step = { kind: 'gap', until: now + PURCHASE_GAP_MS };
      }
      if (ev.kind === 'notice') log(`aviso do servidor: ${ev.text}`);
    }
    switch (this.phase) {
      case 'loading':
        this.tickLoading(t);
        break;
      case 'pricing':
        this.tickPricing(t);
        break;
      case 'preview':
        if (this.confirmed) this.beginBuying(t);
        break;
      case 'buying':
        this.tickBuying(t);
        break;
      case 'floorplan':
        this.tickFloorPlan(t);
        break;
      case 'placing':
        this.tickPlacing(t);
        break;
      case 'verifying':
        this.tickVerifying(t);
        break;
      case 'paint':
        this.tickPaint(t);
        break;
      case 'floorplan-final':
        this.tickFinalFloorPlan(t);
        break;
      case 'refining':
        this.tickRefining(t);
        break;
    }
  }

  /* ------------------------------------ fases ------------------------------------ */

  private tickLoading(t: PasteTick): void {
    const { now, snapshot, log } = t;
    if (this.sawInventory && snapshot.catalogIndex) {
      this.buildPlan(t);
      return;
    }
    if (now - this.startedAt > LOAD_TIMEOUT_MS) {
      if (!this.sawInventory) this.fail('o inventário não chegou em 20 s', log);
      else this.fail('o índice do catálogo não chegou em 20 s', log);
    }
  }

  /**
   * "Continuar construção": confere o JSON contra o quarto, registra o que já está lá como colocado (assim a
   * verificação final acerta altura, rotação e estado deles sem comprar nada) e devolve a cópia reduzida ao
   * que falta, com a lista de compras refeita — é o que impede comprar de novo o que já foi colocado.
   */
  private reconcile(copy: RoomCopy, t: PasteTick): RoomCopy {
    const m = matchPlaced(copy, t.snapshot);
    this.report.resumedFloor = m.floorMatched.length;
    this.report.resumedWall = m.wallMatched.length;
    this.report.strays = m.strays;
    for (const f of m.floorMatched) this.placements.push({ copyItem: f.want, itemId: f.itemId });
    for (const wl of m.wallMatched) this.wallPlacements.push({ item: wl.want, itemId: wl.itemId });
    const found = m.floorMatched.length + m.wallMatched.length;
    if (found === 0) return copy;
    t.log(
      `continuando: ${m.floorMatched.length} mobi(s) de chão e ${m.wallMatched.length} de parede do JSON já estão no quarto; faltam ${m.floorMissing.length} e ${m.wallMissing.length}. Nada deles é comprado de novo; a verificação final acerta altura, rotação e estado.` +
        (m.strays > 0 ? ` ${m.strays} mobi(s) do mesmo tipo estão no quarto fora de qualquer posição do JSON (sobra de uma interrupção ou mobília que já era sua): ficam onde estão.` : ''),
    );
    return { ...copy, floorItems: m.floorMissing, wallItems: m.wallMissing, shopping: shoppingFor(m.floorMissing, m.wallMissing) };
  }

  private buildPlan(t: PasteTick): void {
    const { snapshot, catalog, walls, log } = t;
    const copy = this.copy!;
    const remaining = this.options.resume ? this.reconcile(copy, t) : copy;
    this.remaining = remaining;
    const { purchases, fromInventory } = planPurchases(remaining, snapshot.inventory, catalog, walls, (o) => this.pageFor(o, snapshot));
    const paint = Object.entries(copy.paint)
      .filter(([type]) => PAINT_CLASSES.has(type))
      // Continuando: o que já está pintado assim não precisa de outro 711.
      .filter(([type, value]) => !(this.options.resume && snapshot.room.paint[type] === value))
      .map(([type, value]) => {
        const item = snapshot.inventory.find((it) => it.type === 'I' && walls?.[it.spriteId]?.name === type && paintValue(it) === value);
        return { type, value, itemId: item?.itemId ?? null };
      });
    this.plan = { purchases, fromInventory, totalCredits: 0, totalPoints: 0, unpurchasable: 0, floorPlanChanges: floorPlanDiffers(copy, snapshot), paint };
    this.pagesToFetch = [...new Set(purchases.filter((p) => !p.blocked && p.pageId !== null).map((p) => p.pageId!))].filter((id) => !snapshot.catalogPages.has(id));
    this.progress = { done: 0, total: this.pagesToFetch.length };
    this.phase = 'pricing';
    this.setStatus(`${purchases.length} tipo(s) para comprar; lendo ${this.pagesToFetch.length} página(s) do catálogo para os preços…`, log);
    this.step = { kind: 'none' };
  }

  private pageFor(offerId: number, snapshot: GameSnapshot): number | null {
    if (!snapshot.catalogIndex) return null;
    for (const n of snapshot.catalogIndex) if (n.offerIds.includes(offerId)) return n.pageId;
    return null;
  }

  private tickPricing(t: PasteTick): void {
    const { now, snapshot, actions, log } = t;
    if (this.step.kind === 'page') {
      if (snapshot.catalogPages.has(this.step.pageId)) {
        this.progress.done++;
        this.step = { kind: 'none' };
      } else if (now - this.step.since > PAGE_TIMEOUT_MS) {
        log(`a página ${this.step.pageId} do catálogo não chegou; as ofertas dela ficam sem preço.`);
        this.progress.done++;
        this.step = { kind: 'none' };
      } else return;
    }
    const next = this.pagesToFetch.shift();
    if (next !== undefined) {
      actions.requestCatalogPage(next);
      this.step = { kind: 'page', pageId: next, since: now };
      return;
    }
    const plan = this.plan!;
    for (const pl of plan.purchases) {
      if (pl.blocked || pl.pageId === null) continue;
      priceLine(pl, findOffer(snapshot.catalogPages.get(pl.pageId), pl.kind, pl.type), pl.kind);
    }
    Object.assign(plan, planTotals(plan.purchases));
    this.phase = 'preview';
    const buy = plan.purchases.filter((p) => !p.blocked);
    const resumed = this.report.resumedFloor + this.report.resumedWall;
    this.setStatus(`prévia pronta: ${resumed > 0 ? `${resumed} mobi(s) já estão no quarto (continuando); ` : ''}${buy.reduce((n, p) => n + p.quantity, 0)} unidade(s) em ${purchaseCalls(buy)} compra(s) (máx. ${MAX_PURCHASE_QTY} por compra), ${plan.totalCredits} créditos e ${plan.totalPoints} pontos; ${plan.unpurchasable} mobi(s) sem oferta; ${plan.fromInventory} vêm do inventário. Confirme para continuar.`, log);
  }

  private beginBuying(t: PasteTick): void {
    const plan = this.plan!;
    const lines = this.options.buyMissing ? plan.purchases.filter((p) => !p.blocked && p.quantity > 0) : [];
    this.purchaseQueue = splitPurchases(lines);
    this.progress = { done: 0, total: this.purchaseQueue.length };
    this.phase = 'buying';
    this.step = { kind: 'none' };
    const units = lines.reduce((n, l) => n + l.quantity, 0);
    this.setStatus(this.purchaseQueue.length ? `comprando ${units} unidade(s) de ${lines.length} oferta(s) em ${this.purchaseQueue.length} compra(s) (máx. ${MAX_PURCHASE_QTY} por compra)…` : 'nada a comprar.', t.log);
  }

  private tickBuying(t: PasteTick): void {
    const { now, actions, log } = t;
    if (this.step.kind === 'gap') {
      if (now < this.step.until) return;
      this.step = { kind: 'none' };
      this.progress.done++;
    } else if (this.step.kind === 'purchase') {
      if (now - this.step.since > PURCHASE_TIMEOUT_MS) {
        this.report.purchaseFailed += this.step.line.quantity;
        log(`a compra de ${this.step.line.name ?? '#' + this.step.line.type} não foi confirmada em ${PURCHASE_TIMEOUT_MS / 1000} s (saldo? limite?); seguindo.`);
        this.step = { kind: 'gap', until: now + PURCHASE_GAP_MS };
      }
      return;
    } else if (this.step.kind === 'inventory') {
      if (this.sawInventory) {
        this.step = { kind: 'none' };
        this.beginFloorPlan(t);
      } else if (now - this.step.since > LOAD_TIMEOUT_MS) {
        log('o inventário não recarregou depois das compras; seguindo com o que há.');
        this.step = { kind: 'none' };
        this.beginFloorPlan(t);
      }
      return;
    }
    const next = this.purchaseQueue.shift();
    if (next) {
      actions.purchase(next.pageId!, next.offerId, next.extra, next.quantity);
      log(`comprando ${next.name ?? '#' + next.type} ×${next.quantity} (página ${next.pageId}, oferta ${next.offerId}${next.extra ? `, extra "${next.extra}"` : ''})…`);
      this.step = { kind: 'purchase', line: next, since: now, offerId: next.offerId };
      return;
    }
    if (this.progress.total > 0) {
      this.sawInventory = false;
      actions.requestInventory();
      this.step = { kind: 'inventory', since: now };
      this.setStatus('compras feitas; recarregando o inventário…', log);
      return;
    }
    this.beginFloorPlan(t);
  }

  private doorFor(t: PasteTick): { x: number; y: number; direction: number } {
    const copy = this.copy!;
    return copy.floorPlan!.door ?? t.snapshot.room.door ?? firstFloorTile(copy.floorPlan!.rows);
  }

  /** Antes dos mobis: a planta de obra (o piso padrão, todo em 0). */
  private beginFloorPlan(t: PasteTick): void {
    const copy = this.copy!;
    this.phase = 'floorplan';
    const pending = this.remaining ?? copy;
    // A planta de obra existe só para caber mobi em toda coordenada. Se não há nada a colocar (quarto já
    // pronto, "continuar construção" achando tudo no lugar), ela só trocaria o piso duas vezes de graça —
    // e cada troca faz o servidor reassentar ou recolher o que está em cima. A planta real vai no fim.
    const toPlace = this.options.placeItems ? pending.floorItems.length + pending.wallItems.length : 0;
    const build = this.options.applyFloorPlan && copy.floorPlan && toPlace > 0 ? buildFloorPlan(copy, t.catalog) : null;
    if (!build && this.options.applyFloorPlan && copy.floorPlan && toPlace === 0) {
      t.log('nada a colocar: a planta de obra é dispensada; só a planta real do JSON, no fim, se ela estiver diferente.');
    }
    if (build && copy.floorPlan && (rowsDiffer(build.rows, t.snapshot) || doorDiffers(copy, t.snapshot))) {
      const door = BUILD_FLOOR.door;
      t.actions.saveFloorPlan(build.rows, door, build.wallHeight);
      this.step = { kind: 'floorplan', rows: build.rows, since: t.now };
      this.setStatus(`salvando a planta de obra (piso padrão ${BUILD_FLOOR.size}×${BUILD_FLOOR.size} todo em 0, parede ${build.wallHeight}, porta em ${door.x},${door.y}${build.opened ? `; ${build.opened} casa(s) de mobi sem chão no JSON ficam abertas` : ''}${build.outside ? `; ATENÇÃO: ${build.outside} casa(s) de mobi fora do piso padrão` : ''})… o servidor vai reentrar no quarto; a planta real vai no fim.`, t.log);
      return;
    }
    this.beginPlacing(t);
  }

  /** A planta do passo foi aplicada (linhas iguais e quarto recarregado)? Null enquanto espera; false se estourou o prazo. */
  private floorPlanApplied(t: PasteTick): boolean | null {
    if (this.step.kind !== 'floorplan') return true;
    const { now, snapshot } = t;
    if (!rowsDiffer(this.step.rows, snapshot) && snapshot.room.id !== null && now - this.step.since > 1500) return true;
    if (now - this.step.since > FLOORPLAN_TIMEOUT_MS) return false;
    return null;
  }

  private tickFloorPlan(t: PasteTick): void {
    const applied = this.floorPlanApplied(t);
    if (applied === null) return;
    if (!applied) {
      // Sem a planta de obra, boa parte das casas não existe: colocar 900 mobis às cegas só gera falhas. Melhor parar.
      this.fail('a planta de obra não foi confirmada em 20 s: o servidor não respondeu ao 875 (planta ou altura de parede fora do que o editor aceita? sem direitos?). Nada foi colocado. Confira no :floor se essa planta salva à mão, ou desligue "Aplicar a planta".', t.log);
      return;
    }
    t.log('planta de obra aplicada e quarto recarregado.');
    this.beginPlacing(t);
  }

  /** No fim: a planta real do JSON (fecha as casas abertas na obra), e conferência de que os mobis continuam lá. */
  private beginFinalFloorPlan(t: PasteTick): void {
    const copy = this.copy!;
    this.phase = 'floorplan-final';
    this.step = { kind: 'none' };
    if (this.options.applyFloorPlan && copy.floorPlan && floorPlanDiffers(copy, t.snapshot)) {
      const door = this.doorFor(t);
      const build = buildFloorPlan(copy, t.catalog);
      t.actions.saveFloorPlan(copy.floorPlan.rows, door, copy.floorPlan.wallHeight);
      this.step = { kind: 'floorplan', rows: copy.floorPlan.rows, since: t.now };
      this.setStatus(`aplicando a planta final${build?.opened ? ` (fecha ${build.opened} casa(s) sob mobis)` : ''}… o servidor vai reentrar no quarto.`, t.log);
      return;
    }
    this.beginRefining(t);
  }

  private tickFinalFloorPlan(t: PasteTick): void {
    const { now, snapshot, log } = t;
    if (this.step.kind === 'floorplan-check') {
      if (now < this.step.until) return;
      const byId = new Map(snapshot.room.floorItems.map((f) => [f.id, f]));
      let lost = 0;
      let moved = 0;
      for (const p of this.placements) {
        const cur = byId.get(p.itemId);
        if (!cur) lost++;
        else if (cur.x !== p.copyItem.x || cur.y !== p.copyItem.y || Math.abs(cur.z - p.copyItem.z) > HEIGHT_EPSILON) moved++;
      }
      this.report.lostOnFloorPlan = lost;
      this.report.movedOnFloorPlan = moved;
      log(lost || moved ? `após a planta final: ${lost} mobi(s) colocado(s) sumiram do quarto (o servidor recolhe o que fica sem chão?) e ${moved} mudaram de casa ou altura — o refino vai acertar os que continuam no quarto.` : `após a planta final: todos os ${this.placements.length} mobis colocados continuam onde estavam.`);
      this.beginRefining(t);
      return;
    }
    const applied = this.floorPlanApplied(t);
    if (applied === null) return;
    if (applied) {
      log('planta final aplicada e quarto recarregado; conferindo os mobis…');
      this.step = { kind: 'floorplan-check', until: now + 1500 };
    } else {
      log('a planta final não foi confirmada em 20 s; confira a planta à mão (:floor). Refinando com a planta que está no quarto.');
      this.beginRefining(t);
    }
  }

  private beginPlacing(t: PasteTick): void {
    // Só o que falta: no modo "continuar", quem já está no quarto ficou de fora em `reconcile`.
    const copy = this.remaining ?? this.copy!;
    this.phase = 'placing';
    this.step = { kind: 'none' };
    this.ops = [];
    this.usedInventory.clear();
    for (const it of t.snapshot.room.floorItems) this.usedInventory.add(it.id);
    // Por altura (pilhas de baixo para cima), depois por estado: mobis seguidos com a mesma altura e estado
    // reaproveitam os modos `:up`/`:state` ligados, sem ligar e desligar a cada um.
    this.floorQueue = this.options.placeItems ? [...copy.floorItems].sort((a, b) => a.z - b.z || a.state.localeCompare(b.state) || a.y - b.y || a.x - b.x) : [];
    this.wallQueue = this.options.placeItems ? [...copy.wallItems] : [];
    this.progress = { done: 0, total: this.floorQueue.length + this.wallQueue.length };
    this.setStatus(`colocando ${this.floorQueue.length} mobi(s) de chão e ${this.wallQueue.length} de parede, cada um já com altura, rotação e estado conferidos…`, t.log);
  }

  private takeInventory(snapshot: GameSnapshot, kind: 'floor' | 'wall', type: number): InventoryItem | null {
    for (const it of inventoryFor(snapshot.inventory, kind, type)) {
      if (this.usedInventory.has(it.itemId)) continue;
      this.usedInventory.add(it.itemId);
      return it;
    }
    return null;
  }

  /** Operações que levam o mobi do estado atual ao pedido, tudo num só movimento (modos ligados antes, desligados depois). */
  /** Valor do `:up` que deixa o mobi na altura pedida: relativo ao piso da casa de destino (ou absoluto, se o servidor assim se comportou). */
  private upValueFor(want: RoomCopyFloorItem, snapshot: GameSnapshot): number {
    const floorZ = this.upRelative ? floorHeightAt(snapshot, want.x, want.y) ?? 0 : 0;
    return Math.round((want.z - floorZ) * 1000) / 1000;
  }

  /**
   * O ajuste estourou o prazo com `:up` ligado: o servidor entendeu o valor do outro jeito (absoluto em vez de
   * relativo ao piso, ou vice-versa)? Se sim, troca a interpretação (uma vez por sentido) e devolve true.
   */
  private detectUpSemantics(cur: FloorItem, want: RoomCopyFloorItem, snapshot: GameSnapshot, log: (m: string) => void): boolean {
    const sent = this.buildMode.up;
    if (sent === null || this.upSemanticsFlips >= 2 || cur.x !== want.x || cur.y !== want.y) return false;
    const floorZ = floorHeightAt(snapshot, want.x, want.y) ?? 0;
    if (Math.abs(floorZ) < HEIGHT_EPSILON) return false; // no piso 0 os dois jeitos coincidem
    const gotAbsolute = Math.abs(cur.z - sent) < HEIGHT_EPSILON && Math.abs(want.z - sent) > HEIGHT_EPSILON;
    const gotRelative = Math.abs(cur.z - (sent + floorZ)) < HEIGHT_EPSILON && Math.abs(want.z - (sent + floorZ)) > HEIGHT_EPSILON;
    if (this.upRelative && gotAbsolute) {
      this.upRelative = false;
      this.upSemanticsFlips++;
      log(`o servidor tratou :up ${formatHeight(sent)} como altura absoluta (piso da casa em ${formatHeight(floorZ)}, mobi ficou em ${formatHeight(cur.z)}); passando a mandar a altura absoluta.`);
      return true;
    }
    if (!this.upRelative && gotRelative) {
      this.upRelative = true;
      this.upSemanticsFlips++;
      log(`o servidor tratou :up ${formatHeight(sent)} como relativo ao piso (${formatHeight(floorZ)}); voltando a mandar a altura relativa.`);
      return true;
    }
    return false;
  }

  private fixOps(p: Placement, cur: FloorItem, snapshot: GameSnapshot, forceHeight = false): Op[] {
    const want = p.copyItem;
    const m = mismatchOf(cur, want);
    if (!hasMismatch(m)) return [];
    const ops: Op[] = [];
    if (needsMove(m)) {
      // Altura: mudando de casa ela vai explícita (sem `:up` o servidor recusaria empilhar sobre mobi não empilhável).
      // O modo fica ligado entre mobis seguidos com o mesmo valor; só mandamos o comando quando o valor muda.
      const upVal = this.upValueFor(want, snapshot);
      const needUp = m.z || (forceHeight && m.position) || this.buildMode.up !== null;
      if (needUp && this.buildMode.up !== upVal) ops.push({ kind: 'chat', text: `:up ${formatHeight(upVal)}` });
      ops.push({ kind: 'move', p, label: describeMismatch({ ...m, state: false }, cur, want), final: !m.state });
    }
    // Estado: `:state` só vale na colocação; depois de colocado, o jeito é "usar" (99) até bater.
    if (m.state) ops.push({ kind: 'floor-use', p, final: true });
    return ops;
  }

  /** Tira da fila o que ainda restava para este mobi (depois de uma falha, o resto não faz sentido). */
  private dropOpsOf(p: Placement): void {
    this.ops = this.ops.filter((o) => o.kind === 'chat' || o.kind === 'wall-use' || o.p !== p);
  }

  /**
   * Modos certos ANTES de colocar: `:state` só vale na colocação, então vai armado com o estado do JSON (modo
   * desligado equivale a 0); `:up` fica desligado numa colocação direta (o mobi nasce no piso) e tanto faz numa
   * casa de apoio (o mover seguinte manda a altura de qualquer jeito).
   */
  private prePlaceOps(item: RoomCopyFloorItem, staged: boolean): Op[] {
    const ops: Op[] = [];
    if (!staged && this.buildMode.up !== null) ops.push({ kind: 'chat', text: ':up' });
    const desired = stateIsSettable(item) ? item.state : null;
    const cur = this.buildMode.state;
    if (desired === null) {
      if (cur !== null) ops.push({ kind: 'chat', text: ':state' });
    } else if (cur !== desired && !(desired === '0' && cur === null)) {
      ops.push({ kind: 'chat', text: `:state ${desired}` });
    }
    return ops;
  }

  /** Desliga os modos que estiverem ligados (antes de uma colocação direta, ao fim da fase, ao cancelar). */
  private offOps(): Op[] {
    const ops: Op[] = [];
    if (this.buildMode.up !== null) ops.push({ kind: 'chat', text: ':up' });
    if (this.buildMode.state !== null) ops.push({ kind: 'chat', text: ':state' });
    return ops;
  }

  /** Executa a fila de operações. Devolve true enquanto houver algo em andamento. */
  private runOps(t: PasteTick, onVerified: (ok: boolean) => void): boolean {
    const { now, snapshot, actions, log } = t;
    if (this.step.kind === 'chat') {
      if (now < this.step.until) return true;
      this.step = { kind: 'none' };
    } else if (this.step.kind === 'verify-move') {
      const st = this.step;
      const cur = snapshot.room.floorItems.find((f) => f.id === st.p.itemId);
      if (cur && !needsMove(mismatchOf(cur, st.p.copyItem))) {
        this.step = { kind: 'gap', until: now + this.options.paceMs };
        if (st.final) onVerified(true);
      } else if (now - st.since > ADJUST_TIMEOUT_MS) {
        if (cur && this.detectUpSemantics(cur, st.p.copyItem, snapshot, log)) {
          this.dropOpsOf(st.p);
          this.ops.unshift(...this.fixOps(st.p, cur, snapshot, true));
          this.step = { kind: 'gap', until: now + this.options.paceMs };
          return true;
        }
        log(`${st.p.copyItem.name ?? '#' + st.p.copyItem.type} em (${st.p.copyItem.x}, ${st.p.copyItem.y}): ajuste (${st.label}) não confirmado${cur ? ` — ficou ${describeMismatch(mismatchOf(cur, st.p.copyItem), cur, st.p.copyItem) || 'igual'}` : ''}.`);
        this.dropOpsOf(st.p);
        this.step = { kind: 'gap', until: now + this.options.paceMs };
        onVerified(false);
      } else return true;
    } else if (this.step.kind === 'floor-state') {
      const st = this.step;
      const cur = snapshot.room.floorItems.find((f) => f.id === st.p.itemId);
      const want = st.p.copyItem;
      if (cur && cur.state === want.state) {
        this.step = { kind: 'gap', until: now + this.options.paceMs };
        if (st.final) onVerified(true);
      } else if (now - st.since > ADJUST_TIMEOUT_MS / 2) {
        if (st.toggles >= MAX_STATE_TOGGLES || !cur) {
          log(`estado de ${want.name ?? '#' + want.type} em (${want.x}, ${want.y}) não chegou a ${want.state} em ${st.toggles} uso(s)${cur ? ` (ficou ${cur.state})` : ''}.`);
          this.dropOpsOf(st.p);
          this.step = { kind: 'gap', until: now + this.options.paceMs };
          onVerified(false);
        } else {
          actions.useFloorItem(st.p.itemId);
          this.step = { ...st, toggles: st.toggles + 1, since: now };
          return true;
        }
      } else return true;
    } else if (this.step.kind === 'wall-state') {
      const st = this.step;
      const cur = snapshot.room.wallItems.find((w) => w.id === st.w.itemId);
      if (cur && cur.state === st.w.item.state) {
        this.step = { kind: 'gap', until: now + this.options.paceMs };
        onVerified(true);
      } else if (now - st.since > ADJUST_TIMEOUT_MS / 2) {
        if (st.toggles >= MAX_STATE_TOGGLES) {
          log(`estado do mobi de parede ${st.w.item.name ?? '#' + st.w.item.type} não chegou a ${st.w.item.state} em ${MAX_STATE_TOGGLES} usos.`);
          this.step = { kind: 'gap', until: now + this.options.paceMs };
          onVerified(false);
        } else {
          actions.useWallItem(parseInt(st.w.itemId, 10));
          this.step = { ...st, toggles: st.toggles + 1, since: now };
          return true;
        }
      } else return true;
    } else if (this.step.kind === 'gap') {
      if (now < this.step.until) return true;
      this.step = { kind: 'none' };
    }
    const op = this.ops.shift();
    if (!op) return false;
    if (op.kind === 'chat') {
      if (op.text.startsWith(':up')) this.buildMode.up = op.text === ':up' ? null : parseFloat(op.text.slice(4));
      if (op.text.startsWith(':state')) this.buildMode.state = op.text === ':state' ? null : op.text.slice(7);
      actions.chat(op.text);
      this.step = { kind: 'chat', until: now + CHAT_SETTLE_MS };
    } else if (op.kind === 'move') {
      const c = op.p.copyItem;
      actions.moveFloorItem(op.p.itemId, c.x, c.y, c.direction);
      this.step = { kind: 'verify-move', p: op.p, label: op.label, since: now, final: op.final };
    } else if (op.kind === 'floor-use') {
      actions.useFloorItem(op.p.itemId);
      this.step = { kind: 'floor-state', p: op.p, toggles: 1, since: now, final: op.final };
    } else {
      actions.useWallItem(parseInt(op.w.itemId, 10));
      this.step = { kind: 'wall-state', w: op.w, toggles: 1, since: now };
    }
    return true;
  }

  /** Precisa de casa de apoio? Se alguma casa do destino já tem mobi, ou se a altura pedida não é a do piso. */
  private needsStaging(item: RoomCopyFloorItem, snapshot: GameSnapshot, catalog: FurniCatalog | null): boolean {
    const footprint = furniFootprint(item, catalog?.[item.type]);
    const occupied = occupiedTiles(snapshot, catalog);
    if (footprint.some((tl) => occupied.has(`${tl.x},${tl.y}`))) return true;
    const floorZ = floorHeightAt(snapshot, item.x, item.y);
    return floorZ !== null && Math.abs(floorZ - item.z) > HEIGHT_EPSILON;
  }

  private tickPlacing(t: PasteTick): void {
    const { now, snapshot, actions, log } = t;
    // Ajustes do mobi recém-colocado vêm antes do próximo: altura, rotação e estado num só movimento.
    if (this.runOps(t, (ok) => { if (ok) this.report.fixedOnPlace++; else this.report.failed++; })) return;
    if (this.step.kind === 'place-floor') {
      const st = this.step;
      const placed = snapshot.room.floorItems.find((f) => f.id === st.itemId);
      if (placed) {
        if (placed.spriteId !== st.item.type) {
          this.report.typeMismatch++;
          log(`ATENÇÃO: o servidor colocou o tipo ${placed.spriteId} (${t.catalog?.[placed.spriteId]?.name ?? '?'}) no lugar de ${st.item.name ?? '#' + st.item.type} (tipo ${st.item.type}).`);
        }
        const p: Placement = { copyItem: st.item, itemId: st.itemId };
        this.placements.push(p);
        this.report.placedFloor++;
        this.progress.done++;
        const ops = this.fixOps(p, placed, snapshot, st.staged);
        if (ops.length) {
          if (st.staged) log(`${st.item.name ?? '#' + st.item.type} colocado na casa de apoio (${placed.x}, ${placed.y}); levando para (${st.item.x}, ${st.item.y}) com altura ${st.item.z}, rotação ${st.item.direction}.`);
          else log(`${st.item.name ?? '#' + st.item.type} em (${st.item.x}, ${st.item.y}) veio com ${describeMismatch(mismatchOf(placed, st.item), placed, st.item)}; ajustando.`);
          this.ops = ops;
          this.step = { kind: 'none' };
        } else {
          this.step = { kind: 'gap', until: now + this.options.paceMs };
        }
      } else if (now - st.since > PLACE_TIMEOUT_MS) {
        this.report.failed++;
        log(`${st.item.name ?? '#' + st.item.type} não apareceu no quarto${st.staged ? ' (nem na casa de apoio)' : ` em (${st.item.x}, ${st.item.y}) (casa sem chão? ocupada por mobi não empilhável?)`}; seguindo.`);
        this.progress.done++;
        this.step = { kind: 'gap', until: now + this.options.paceMs };
      }
      return;
    }
    if (this.step.kind === 'place-wall') {
      const st = this.step;
      const placed = snapshot.room.wallItems.find((w) => w.id === st.itemId);
      if (placed) {
        const wp: WallPlacement = { item: st.item, itemId: st.itemId };
        this.wallPlacements.push(wp);
        this.report.placedWall++;
        this.progress.done++;
        if (/^-?\d+$/.test(st.item.state) && placed.state !== st.item.state) {
          log(`${st.item.name ?? '#' + st.item.type} na parede veio com estado ${placed.state}; ajustando para ${st.item.state}.`);
          this.ops = [{ kind: 'wall-use', w: wp }];
          this.step = { kind: 'none' };
        } else {
          this.step = { kind: 'gap', until: now + this.options.paceMs };
        }
      } else if (now - st.since > PLACE_TIMEOUT_MS) {
        this.report.failed++;
        log(`${st.item.name ?? '#' + st.item.type} na parede (${st.item.position}) não apareceu; seguindo.`);
        this.progress.done++;
        this.step = { kind: 'gap', until: now + this.options.paceMs };
      }
      return;
    }
    const nextFloor = this.floorQueue.shift();
    if (nextFloor) {
      const inv = this.takeInventory(snapshot, 'floor', nextFloor.type);
      if (!inv) {
        this.report.missingFloor++;
        this.progress.done++;
        return;
      }
      // Casa de destino já com mobi, ou altura acima do piso: colocar direto falharia ou cairia na altura errada.
      // Coloca numa casa livre e leva ao destino com `:up` (é para isso que o comando existe).
      const stage = this.needsStaging(nextFloor, snapshot, t.catalog) ? findStagingTile(snapshot, t.catalog, nextFloor) : null;
      const pre = this.prePlaceOps(nextFloor, !!stage);
      if (pre.length) {
        // Arma o estado (e desliga o :up numa colocação direta) antes; coloca no próximo tick.
        this.floorQueue.unshift(nextFloor);
        this.usedInventory.delete(inv.itemId);
        this.ops = pre;
        return;
      }
      if (stage) {
        actions.placeFloorItem(inv.itemId, stage.x, stage.y, nextFloor.direction);
        this.report.staged++;
        this.step = { kind: 'place-floor', item: nextFloor, itemId: inv.itemId, since: now, staged: true };
        this.setStatus(`colocando ${nextFloor.name ?? '#' + nextFloor.type} na casa de apoio (${stage.x}, ${stage.y}) para levar a (${nextFloor.x}, ${nextFloor.y}) z ${nextFloor.z}… ${this.progress.done + 1}/${this.progress.total}`, null);
        return;
      }
      actions.placeFloorItem(inv.itemId, nextFloor.x, nextFloor.y, nextFloor.direction);
      this.step = { kind: 'place-floor', item: nextFloor, itemId: inv.itemId, since: now, staged: false };
      this.setStatus(`colocando ${nextFloor.name ?? '#' + nextFloor.type} em (${nextFloor.x}, ${nextFloor.y}) rot ${nextFloor.direction} z ${nextFloor.z}… ${this.progress.done + 1}/${this.progress.total}`, null);
      return;
    }
    const nextWall = this.wallQueue.shift();
    if (nextWall) {
      const inv = this.takeInventory(snapshot, 'wall', nextWall.type);
      if (!inv) {
        this.report.missingWall++;
        this.progress.done++;
        return;
      }
      if (this.buildMode.up !== null || this.buildMode.state !== null) {
        this.wallQueue.unshift(nextWall);
        this.usedInventory.delete(inv.itemId);
        this.ops = this.offOps();
        return;
      }
      actions.placeWallItem(inv.itemId, nextWall.position);
      this.step = { kind: 'place-wall', item: nextWall, itemId: String(inv.itemId), since: now };
      this.setStatus(`colocando ${nextWall.name ?? '#' + nextWall.type} na parede… ${this.progress.done + 1}/${this.progress.total}`, null);
      return;
    }
    if (this.buildMode.up !== null || this.buildMode.state !== null) {
      this.ops = this.offOps();
      return;
    }
    this.beginVerifying(t);
  }

  /** Passada final: confere TODOS os mobis colocados e refaz o ajuste de quem ainda estiver diferente. */
  /** Liga cada item do JSON ao id do mobi que o motor colocou para ele (para apontar quem saiu de lugar). */
  private placedIdMap(): Map<RoomCopyFloorItem, number> {
    const m = new Map<RoomCopyFloorItem, number>();
    for (const p of this.placements) m.set(p.copyItem, p.itemId);
    return m;
  }

  /** Roda a conferência por coordenada contra o JSON inteiro e guarda o resultado. */
  private runAudit(t: PasteTick): RoomAudit {
    this.audit = auditRoom(this.copy!, t.snapshot, this.placedIdMap());
    return this.audit;
  }

  /**
   * Monta a fila de conserto A PARTIR DA CONFERÊNCIA: todo mobi do JSON que está no quarto mas com casa,
   * altura, rotação ou estado diferentes. Antes a fila saía de `this.placements`, então um mobi de uma
   * execução anterior — ou um que nunca chegou a ser colocado — nunca era conferido.
   */
  private queueFromAudit(t: PasteTick): void {
    this.step = { kind: 'none' };
    this.ops = [];
    this.fixing = null;
    this.fixingWall = null;
    this.fixAttempts.clear();
    this.wallFixAttempts.clear();
    const audit = this.runAudit(t);
    this.verifyQueue = audit.floor
      .filter((r) => r.found !== null && r.verdicts.some((v) => FIXABLE_VERDICTS.includes(v)))
      .map((r) => ({ copyItem: r.want, itemId: r.found!.id }));
    this.wallVerifyQueue = audit.wall
      .filter((r) => r.found !== null && r.verdicts.includes('wrong-state'))
      .map((r) => ({ item: r.want, itemId: r.found!.id }));
    this.verifyFailures = 0;
    this.progress = { done: 0, total: this.verifyQueue.length + this.wallVerifyQueue.length };
  }

  private beginVerifying(t: PasteTick): void {
    this.phase = 'verifying';
    this.queueFromAudit(t);
    const a = this.audit!;
    this.setStatus(
      this.progress.total
        ? `verificação: ${this.verifyQueue.length} mobi(s) de chão e ${this.wallVerifyQueue.length} de parede diferentes do JSON; ajustando…`
        : `verificação: os ${a.ok} mobis conferidos estão na casa, altura, rotação e estado do JSON.`,
      t.log,
    );
  }

  /**
   * Refino: a passada DEPOIS da planta final. Confere altura, rotação, posição e estado de cada mobi
   * contra o JSON já com o piso definitivo no lugar, e conserta o que a troca de planta desarrumou.
   * Antes isto só era relatado (`movedOnFloorPlan`) e a colagem terminava com mobis tortos.
   */
  private beginRefining(t: PasteTick): void {
    this.phase = 'refining';
    this.queueFromAudit(t);
    const a = this.audit!;
    this.setStatus(
      this.progress.total
        ? `refino após a planta: ${this.verifyQueue.length} mobi(s) de chão e ${this.wallVerifyQueue.length} de parede ficaram diferentes (a troca de piso reassenta o que está em cima); acertando…`
        : `refino após a planta: os ${a.ok} mobis conferidos estão na casa, altura, rotação e estado do JSON.`,
      t.log,
    );
  }

  /** Recoloca na fila o mobi que acabou de falhar, se ainda tem tentativa. */
  private retryFix(t: PasteTick): boolean {
    const p = this.fixing;
    if (p) {
      const n = (this.fixAttempts.get(p.itemId) ?? 1) + 1;
      if (n > MAX_FIX_ATTEMPTS) return false;
      this.fixAttempts.set(p.itemId, n);
      this.verifyQueue.push(p);
      this.progress.total++;
      t.log(`${p.copyItem.name ?? '#' + p.copyItem.type} em (${p.copyItem.x}, ${p.copyItem.y}): tentativa ${n} de ${MAX_FIX_ATTEMPTS}.`);
      return true;
    }
    const w = this.fixingWall;
    if (!w) return false;
    const n = (this.wallFixAttempts.get(w.itemId) ?? 1) + 1;
    if (n > MAX_FIX_ATTEMPTS) return false;
    this.wallFixAttempts.set(w.itemId, n);
    this.wallVerifyQueue.push(w);
    this.progress.total++;
    return true;
  }

  /** Motor das duas passadas de conserto. `final` = depois da planta; `onDone` = o que vem em seguida. */
  private tickFixQueue(t: PasteTick, final: boolean, onDone: (t: PasteTick) => void): void {
    const { snapshot } = t;
    if (
      this.runOps(t, (ok) => {
        this.progress.done++;
        if (ok) {
          if (final) this.report.fixedOnFinal++;
          else this.report.fixedOnVerify++;
          return;
        }
        if (this.retryFix(t)) return;
        this.report.failed++;
        this.verifyFailures++;
      })
    )
      return;
    const next = this.verifyQueue.shift();
    if (next) {
      this.fixing = next;
      this.fixingWall = null;
      const cur = snapshot.room.floorItems.find((f) => f.id === next.itemId);
      // `forceHeight` na passada final: depois da planta o piso mudou, então a altura vai explícita no mover.
      if (cur) this.ops = this.fixOps(next, cur, snapshot, final);
      if (!this.ops.length) this.progress.done++;
      return;
    }
    const nextWall = this.wallVerifyQueue.shift();
    if (nextWall) {
      this.fixing = null;
      this.fixingWall = nextWall;
      this.ops = [{ kind: 'wall-use', w: nextWall }];
      return;
    }
    if (this.buildMode.up !== null || this.buildMode.state !== null) {
      this.ops = this.offOps();
      return;
    }
    this.fixing = null;
    this.fixingWall = null;
    onDone(t);
  }

  private tickVerifying(t: PasteTick): void {
    this.tickFixQueue(t, false, (tt) => this.beginPaint(tt));
  }

  private tickRefining(t: PasteTick): void {
    this.tickFixQueue(t, true, (tt) => {
      // Conferência final: mobi por mobi do JSON contra o quarto, já com tudo no lugar.
      const a = this.runAudit(tt);
      this.report.stillWrong = a.fixable;
      this.report.auditMissing = a.missing + a.wrongType;
      this.report.auditOk = a.ok;
      const problems = [...a.floor, ...a.wall].filter((r) => !r.verdicts.includes('ok'));
      for (const r of problems.slice(0, 40)) tt.log(`conferência [${r.verdicts.join(',')}] ${r.detail}`);
      if (problems.length > 40) tt.log(`conferência: e mais ${problems.length - 40} divergência(s) — use "Exportar conferência" para a lista completa.`);
      this.finish(tt.log);
    });
  }

  private beginPaint(t: PasteTick): void {
    this.phase = 'paint';
    this.step = { kind: 'none' };
    this.paintQueue = this.options.applyPaint && this.plan ? this.plan.paint.filter((p) => p.itemId !== null).map((p) => p.itemId!) : [];
    const missing = this.options.applyPaint && this.plan ? this.plan.paint.filter((p) => p.itemId === null) : [];
    if (missing.length) t.log(`sem item no inventário para ${missing.map((m) => `${m.type} ${m.value}`).join(', ')}: a pintura fica como está (compre o padrão no catálogo e aplique à mão).`);
    this.progress = { done: 0, total: this.paintQueue.length };
    if (this.paintQueue.length) this.setStatus(`aplicando ${this.paintQueue.length} pintura(s)…`, t.log);
  }

  private tickPaint(t: PasteTick): void {
    const { now, actions } = t;
    if (this.step.kind === 'gap') {
      if (now < this.step.until) return;
      this.step = { kind: 'none' };
    }
    const next = this.paintQueue.shift();
    if (next !== undefined) {
      actions.applyDecoration(next);
      this.progress.done++;
      this.step = { kind: 'gap', until: now + this.options.paceMs };
      return;
    }
    this.beginFinalFloorPlan(t);
  }

  /* ------------------------------------ interno ------------------------------------ */

  private turnOffBuildModes(t: PasteTick): void {
    if (this.buildMode.up !== null) t.actions.chat(':up');
    if (this.buildMode.state !== null) t.actions.chat(':state');
    this.buildMode = { up: null, state: null };
  }

  private finish(log: (m: string) => void): void {
    this.phase = 'done';
    const r = this.report;
    this.setStatus(`pronto: ${r.placedFloor} mobi(s) de chão e ${r.placedWall} de parede colocados${r.resumedFloor + r.resumedWall > 0 ? ` (${r.resumedFloor + r.resumedWall} já estavam no quarto)` : ''}; ${r.fixedOnPlace} ajustado(s) na colocação, ${r.fixedOnVerify} na verificação e ${r.fixedOnFinal} no refino depois da planta. Conferência por coordenada: ${r.auditOk} de ${r.auditOk + r.auditMissing + r.stillWrong} mobis do JSON conferem; ${r.auditMissing} falta(m) colocar e ${r.stillWrong} ficaram diferentes; ${r.missingFloor + r.missingWall} sem mobi no inventário; ${r.failed} falha(s); ${r.purchased} comprado(s)${r.purchaseFailed ? `, ${r.purchaseFailed} compra(s) não confirmada(s)` : ''}${r.lostOnFloorPlan || r.movedOnFloorPlan ? `; após a planta final ${r.lostOnFloorPlan} sumiram e ${r.movedOnFloorPlan} mudaram` : ''}.`, log);
  }

  private fail(msg: string, log: (m: string) => void): void {
    this.phase = 'error';
    this.setStatus(msg, log);
  }

  private setStatus(msg: string, log: ((m: string) => void) | null): void {
    this.status = msg;
    if (log && msg !== this.lastLog) {
      this.lastLog = msg;
      log(msg);
    }
  }

  private reset(): void {
    this.phase = 'idle';
    this.status = '';
    this.plan = null;
    this.remaining = null;
    this.audit = null;
    this.report = emptyReport();
    this.progress = { done: 0, total: 0 };
    this.step = { kind: 'none' };
    this.ops = [];
    this.sawInventory = false;
    this.pagesToFetch = [];
    this.purchaseQueue = [];
    this.floorQueue = [];
    this.wallQueue = [];
    this.placements = [];
    this.wallPlacements = [];
    this.usedInventory.clear();
    this.verifyQueue = [];
    this.wallVerifyQueue = [];
    this.fixing = null;
    this.fixingWall = null;
    this.fixAttempts.clear();
    this.wallFixAttempts.clear();
    this.buildMode = { up: null, state: null };
    this.paintQueue = [];
    this.confirmed = false;
    this.lastLog = '';
    this.verifyFailures = 0;
    this.upRelative = true;
    this.upSemanticsFlips = 0;
    this.cursor = new EventCursor();
  }
}

function emptyReport(): PasteReport {
  return { placedFloor: 0, placedWall: 0, missingFloor: 0, missingWall: 0, failed: 0, fixedOnPlace: 0, staged: 0, fixedOnVerify: 0, fixedOnFinal: 0, stillWrong: 0, auditOk: 0, auditMissing: 0, purchased: 0, purchaseFailed: 0, ignored: 0, resumedFloor: 0, resumedWall: 0, strays: 0, typeMismatch: 0, lostOnFloorPlan: 0, movedOnFloorPlan: 0 };
}

/** Casas cobertas por algum mobi de chão do quarto (com o tamanho do furnidata; sem catálogo, 1x1). */
export function occupiedTiles(snapshot: GameSnapshot, catalog: FurniCatalog | null): Set<string> {
  const out = new Set<string>();
  for (const it of snapshot.room.floorItems) for (const tl of furniFootprint(it, catalog?.[it.spriteId])) out.add(`${tl.x},${tl.y}`);
  return out;
}

/** Altura do piso numa casa pela planta (null se desconhecida ou sem chão). */
export function floorHeightAt(snapshot: GameSnapshot, x: number, y: number): number | null {
  const plan = snapshot.room.floorPlan;
  if (!plan) return null;
  const row = plan.rows[y];
  if (!row || x < 0 || x >= row.length) return null;
  return floorPlanHeight(row[x]);
}

/**
 * Casa livre para apoiar um mobi antes de levá-lo ao destino: com chão, sem mobi, sem avatar, fora da porta e
 * fora das casas do próprio destino; a mais perto do destino primeiro. Null se não há (quarto lotado).
 */
export function findStagingTile(snapshot: GameSnapshot, catalog: FurniCatalog | null, item: RoomCopyFloorItem): { x: number; y: number } | null {
  const plan = snapshot.room.floorPlan;
  if (!plan) return null;
  const occupied = occupiedTiles(snapshot, catalog);
  for (const u of snapshot.room.users) {
    occupied.add(`${u.x},${u.y}`);
    if (u.moveTarget) occupied.add(`${u.moveTarget.x},${u.moveTarget.y}`);
  }
  if (snapshot.room.door) occupied.add(`${snapshot.room.door.x},${snapshot.room.door.y}`);
  const dims = catalog?.[item.type];
  for (const tl of furniFootprint(item, dims)) occupied.add(`${tl.x},${tl.y}`);
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let y = 0; y < plan.rows.length; y++) {
    const row = plan.rows[y];
    for (let x = 0; x < row.length; x++) {
      if (floorPlanHeight(row[x]) === null) continue;
      // o mobi precisa caber inteiro em casas livres
      const cells = furniFootprint({ x, y, direction: item.direction }, dims);
      if (cells.some((c) => occupied.has(`${c.x},${c.y}`) || floorHeightAt(snapshot, c.x, c.y) === null)) continue;
      const d = Math.max(Math.abs(x - item.x), Math.abs(y - item.y));
      if (d < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** Primeira casa com chão da planta (para a porta, quando o JSON e o quarto não a informam). */
export function firstFloorTile(rows: string[]): { x: number; y: number; direction: number } {
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y].split('').findIndex((c) => c !== 'x' && c !== 'X' && c !== ' ');
    if (x >= 0) return { x, y, direction: 2 };
  }
  return { x: 0, y: 0, direction: 2 };
}

/** `:up` aceita inteiros e decimais; ao milésimo (pilhas usam 0.001), sem lixo de ponto flutuante. */
export function formatHeight(z: number): string {
  return String(Math.round(z * 1000) / 1000);
}
