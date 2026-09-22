import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PasteSession } from '../src/components/pasteSession';
import { PacketReader } from '../src/protocol/decode';
import { floorPlanHeight, parseCatalogIndex, parseCatalogPage, parseInventory, parseObjectDataUpdate, parsePurchaseOk, parseUnseenItems, parseWallItemAdd } from '../src/protocol/nitro/parsers';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import { GameState } from '../src/protocol/state/GameState';
import { createGameActions } from '../src/protocol/actions';
import type { GameActions } from '../src/protocol/actions';
import { buildRoomCopy } from '../src/protocol/roomCopy';
import { MAX_FIX_ATTEMPTS, RoomPasteEngine, auditIsClean, auditReportText, auditRoom, buildFloorPlan, standardFloorRows, findOffer, findStagingTile, firstFloorTile, floorPlanDiffers, formatHeight, isIgnored, matchPlaced, mismatchOf, planPurchases, priceLine, purchaseCalls, splitPurchases, withoutIgnored } from '../src/protocol/roomPaste';
import type { PurchaseLine } from '../src/protocol/roomPaste';
import type { PasteTick } from '../src/protocol/roomPaste';
import type { FurniCatalog, WallCatalog } from '../shared/furnidata';
import { IN, OUT, captureSends, floorItemAdd, floorItems, roomData, roomUsers, selfInfo, w, writeFloorItem } from './helpers';
import type { PacketWriter } from '../src/protocol/decode';

const CHAIR = 1001;
const RARE = 1005;
const POSTER = 4001;
const catalog: FurniCatalog = {
  [CHAIR]: { name: 'chair_plasto', xdim: 1, ydim: 1, sit: true, lay: false, offerId: 10 },
  [RARE]: { name: 'rare_dragonlamp', xdim: 1, ydim: 1, sit: false, lay: false, offerId: -1 },
  777: { name: 'floor_thing', xdim: 1, ydim: 1, sit: false, lay: false, offerId: 70 },
};
const walls: WallCatalog = { [POSTER]: { name: 'poster', offerId: 900 }, 5000: { name: 'floor', offerId: -1 }, 5001: { name: 'wallpaper', offerId: -1 } };

/* ------------------------------------ escritores sintéticos ------------------------------------ */

interface IdxNode { pageId: number; name: string; offers: number[]; children?: IdxNode[] }

function catalogIndex(nodes: IdxNode[]): PacketWriter {
  const wr = w();
  const write = (n: IdxNode) => {
    wr.boolean(true).int32(0).int32(n.pageId).string(n.name).string(n.name).int32(n.offers.length);
    for (const o of n.offers) wr.int32(o);
    const kids = n.children ?? [];
    wr.int32(kids.length);
    for (const k of kids) write(k);
  };
  write({ pageId: -1, name: 'root', offers: [], children: nodes });
  return wr.string('').boolean(false);
}

function catalogPage(pageId: number, offers: { offerId: number; name: string; credits: number; points?: number; products: { type: string; spriteId: number; extra?: string; count?: number }[]; rent?: boolean }[]): PacketWriter {
  const wr = w().int32(pageId).string('NORMAL').string('default_3x3').int32(1).string('img').int32(2).string('t1').string('t2').int32(offers.length);
  for (const o of offers) {
    wr.int32(o.offerId).string(o.name).boolean(o.rent ?? false).int32(o.credits).int32(o.points ?? 0).int32(0).boolean(true).int32(o.products.length);
    for (const p of o.products) wr.string(p.type).int32(p.spriteId).string(p.extra ?? '').int32(p.count ?? 1).boolean(false);
    wr.int32(0).boolean(true).boolean(false).string('');
  }
  return wr.int32(0).boolean(false);
}

function inventory(items: { id: number; type: 'S' | 'I'; spriteId: number; state?: string }[], fragment = 0, total = 1): PacketWriter {
  const wr = w().int32(total).int32(fragment).int32(items.length);
  for (const it of items) {
    wr.int32(it.id).string(it.type).int32(it.id).int32(it.spriteId).int32(1).int32(0).string(it.state ?? '').boolean(false).boolean(true).boolean(true).boolean(false).int32(-1).boolean(true).int32(-1);
    if (it.type === 'S') wr.string('').int32(0);
  }
  return wr;
}

function wallItemAdd(id: string, spriteId: number, pos: string, state = '0'): PacketWriter {
  return w().string(id).int32(spriteId).string(pos).string(state).int32(-1).int32(0).int32(1).string('Dono');
}

describe('parsers de catálogo, inventário e construção', () => {
  it('1032: índice achatado com ofertas por página', () => {
    const idx = parseCatalogIndex(new PacketReader(catalogIndex([{ pageId: 8, name: 'hc', offers: [1091, 1075] }, { pageId: 24, name: 'janelas', offers: [123], children: [{ pageId: 25, name: 'sub', offers: [9059] }] }]).bytes()));
    expect(idx.nodes.map((n) => `${n.pageId}@${n.depth}`)).toEqual(['-1@0', '8@1', '24@1', '25@2']);
    expect(idx.nodes[1].offerIds).toEqual([1091, 1075]);
  });

  it('804: ofertas com preço e produtos', () => {
    const page = parseCatalogPage(new PacketReader(catalogPage(8, [{ offerId: 1075, name: 'Cadeira', credits: 3, products: [{ type: 's', spriteId: CHAIR }] }, { offerId: 9059, name: 'Pacote', credits: 10, points: 5, products: [{ type: 's', spriteId: 777, count: 5, extra: '0' }] }]).bytes()));
    expect(page.pageId).toBe(8);
    expect(page.offers).toHaveLength(2);
    expect(page.offers[1]).toMatchObject({ offerId: 9059, credits: 10, points: 5, products: [{ type: 's', spriteId: 777, extra: '0', count: 5 }] });
  });

  it('994: inventário com mobis de chão e parede; 2103, 869, 2547, 2187', () => {
    const inv = parseInventory(new PacketReader(inventory([{ id: 1, type: 'S', spriteId: CHAIR, state: '0' }, { id: 2, type: 'I', spriteId: 5000, state: '111' }]).bytes()));
    expect(inv.partial).toBe(false);
    expect(inv.items).toEqual([
      { itemId: 1, type: 'S', spriteId: CHAIR, category: 1, state: '0', tradeable: true, roomId: -1 },
      { itemId: 2, type: 'I', spriteId: 5000, category: 1, state: '111', tradeable: true, roomId: -1 },
    ]);
    expect(parseUnseenItems(new PacketReader(w().int32(1).int32(1).int32(2).int32(55).int32(56).bytes()))).toEqual([{ category: 1, ids: [55, 56] }]);
    expect(parsePurchaseOk(new PacketReader(w().int32(1091).string('hc_lmpst').boolean(false).bytes()))).toEqual({ offerId: 1091, name: 'hc_lmpst' });
    expect(parseObjectDataUpdate(new PacketReader(w().string('136874450').int32(0).string('1').bytes()))).toEqual({ id: 136874450, state: '1' });
    expect(parseWallItemAdd(new PacketReader(wallItemAdd('137083008', POSTER, ':w=0,19 l=9,111 l').bytes()))).toMatchObject({ id: '137083008', spriteId: POSTER, wallPosition: ':w=0,19 l=9,111 l', ownerName: 'Dono' });
  });
});

/* ------------------------------------ mundo de teste ------------------------------------ */

class World {
  state = new GameState();
  sends = captureSends();
  actions: GameActions = createGameActions(this.sends.send, this.state);
  logs: string[] = [];
  now = 1_000_000;
  engine = new RoomPasteEngine();
  nextId = 5000;

  constructor(owner = true) {
    this.state.handle(IN(H.USER_INFO, selfInfo(1, 'Eu'), this.now));
    this.enter(10, owner);
  }

  enter(roomId: number, owner = true, rows = ['xxxx', 'x00x', 'x00x', 'xxxx'], items: Parameters<typeof floorItems>[0] = []): void {
    this.state.handle(OUT(O.ROOM_ENTER, w().int32(roomId).string(''), this.now));
    this.state.handle(IN(H.ROOM_READY, undefined, this.now));
    if (owner) this.state.handle(IN(H.ROOM_RIGHTS_OWNER, undefined, this.now));
    this.state.handle(IN(H.ROOM_FLOOR_PLAN, w().boolean(true).int32(-1).string(rows.join('\r') + '\r').int32(0), this.now));
    this.state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 1, name: 'Eu', roomIndex: 1 }]), this.now));
    this.state.handle(IN(H.ROOM_DATA, roomData({ roomId, name: 'Meu' }), this.now));
    this.state.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems(items), this.now));
  }

  /** Altura do piso na casa pela planta atual (0 se desconhecida). */
  floorZ(x: number, y: number): number {
    const row = this.state.snapshot().room.floorPlan?.rows[y];
    return row ? floorPlanHeight(row[x] ?? 'x') ?? 0 : 0;
  }

  /** Os mobis do quarto como especificação para reentrar com eles (planta final). */
  keptItems(drop: (f: { x: number; y: number }) => boolean = () => false): Parameters<typeof floorItems>[0] {
    return this.state.snapshot().room.floorItems.filter((f) => !drop(f)).map((f) => ({ id: f.id, spriteId: f.spriteId, x: f.x, y: f.y, direction: f.direction, z: f.z, state: f.state }));
  }

  /** Simula um servidor que trata `:up N` como altura absoluta (o padrão simulado é relativo ao piso da casa). */
  upAbsolute = false;
  /** Simula um servidor que ignora o `:state` armado na colocação (o mobi nasce sempre em 0). */
  ignoreStateOnPlace = false;

  /** Modos `:up`/`:state` armados até agora, pela ordem dos chats enviados. */
  modes(): { up: number | null; st: string | null } {
    let up: number | null = null;
    let st: string | null = null;
    for (const c of this.sends.byHeader(O.CHAT).map((p) => p.reader().string())) {
      if (c.startsWith(':up')) up = c === ':up' ? null : parseFloat(c.slice(4));
      if (c.startsWith(':state')) st = c === ':state' ? null : c.slice(7);
    }
    return { up, st };
  }

  /** O servidor responde ao 99 (usar): alterna o estado 0/1 do mobi de chão e avisa com 2547. */
  serverUses(): void {
    for (const p of this.sends.byHeader(O.USE_OBJECT).slice(this.usesDone)) {
      this.usesDone++;
      const id = p.reader().int32();
      const cur = this.state.snapshot().room.floorItems.find((f) => f.id === id);
      if (!cur) continue;
      this.state.handle(IN(H.OBJECT_DATA_UPDATE, w().string(String(id)).int32(0).string(cur.state === '1' ? '0' : '1'), this.now));
    }
  }
  usesDone = 0;

  tick(): PasteTick {
    return { now: this.now, snapshot: this.state.snapshot(), actions: this.actions, catalog, walls, log: (m) => this.logs.push(m) };
  }

  run(ms = 0): void {
    this.now += ms;
    this.engine.tick(this.tick());
  }

  sent(header: number) {
    return this.sends.byHeader(header);
  }

  /** O servidor responde ao 1258: o mobi aparece no quarto (1534) com o `:state` armado e sai do inventário (159). */
  serverPlaces(): void {
    const armed = this.ignoreStateOnPlace ? null : this.modes().st;
    for (const p of this.sends.byHeader(O.PLACE_OBJECT)) {
      const spec = p.reader().string();
      const [idStr, a, b, c] = spec.trim().split(' ');
      const id = parseInt(idStr, 10);
      if (this.answered.has(id)) continue;
      this.answered.add(id);
      const inv = this.state.snapshot().inventory.find((i) => i.itemId === id);
      this.state.handle(IN(H.INVENTORY_REMOVE, w().int32(id), this.now));
      if (a.startsWith(':w=')) this.state.handle(IN(H.ROOM_WALL_ITEM_ADD, wallItemAdd(String(id), inv?.spriteId ?? 0, spec.trim().slice(idStr.length + 1)), this.now));
      else {
        const x = parseInt(a, 10), y = parseInt(b, 10);
        if (this.state.snapshot().room.floorItems.some((f) => f.x === x && f.y === y)) continue; // casa ocupada: o servidor ignora
        this.state.handle(IN(H.ROOM_FLOOR_ITEM_ADD, floorItemAdd({ id, spriteId: inv?.spriteId ?? 0, x, y, direction: this.ignoreDirection ? 0 : parseInt(c, 10), z: this.floorZ(x, y), stackHeight: 1, state: armed ?? '0' }), this.now));
      }
    }
  }
  answered = new Set<number>();
  /** Simula o servidor que coloca o mobi sempre na rotação 0 (visto ao vivo em 21/09/2026). */
  ignoreDirection = false;

  /** O servidor responde ao 248: com `:up N` ligado, o mobi vai para piso + N (ou N, se upAbsolute). `:state` NÃO vale no mover. */
  serverMoves(): void {
    const { up } = this.modes();
    const moves = this.sends.byHeader(O.MOVE_OBJECT);
    // Cada 248 é processado uma vez só, com os modos ligados no momento em que foi enviado (como o servidor faz).
    for (const p of moves.slice(this.movesDone)) {
      this.movesDone++;
      const r = p.reader();
      const id = r.int32(), x = r.int32(), y = r.int32(), dir = r.int32();
      const cur = this.state.snapshot().room.floorItems.find((f) => f.id === id);
      if (!cur) continue;
      // Servidor teimoso: ignora a rotação pedida nos N primeiros movimentos (visto ao vivo) e aceita depois.
      let useDir = dir;
      if (this.dropMoveDirection > 0) {
        this.dropMoveDirection--;
        useDir = cur.direction;
      }
      this.state.handle(IN(H.ROOM_FLOOR_ITEM_UPDATE, writeFloorItem(w(), { id, spriteId: cur.spriteId, x, y, direction: useDir, z: up === null ? cur.z : this.upAbsolute ? up : up + this.floorZ(x, y), stackHeight: cur.stackHeight, state: cur.state }), this.now));
    }
  }
  movesDone = 0;
  /** Quantos movimentos seguintes o servidor devolve SEM aplicar a rotação pedida. */
  dropMoveDirection = 0;
  wallUses = 0;
  confirmedPurchases = 0;
}

function copyFrom(items: Parameters<typeof floorItems>[0], wallSpecs: { id: string; spriteId: number; pos: string; state?: string }[] = [], rows = ['xxxx', 'x00x', 'x00x', 'xxxx']) {
  const src = new GameState();
  src.handle(IN(H.USER_INFO, selfInfo(2, 'Outro')));
  src.handle(OUT(O.ROOM_ENTER, w().int32(99).string('')));
  src.handle(IN(H.ROOM_READY));
  src.handle(IN(H.ROOM_FLOOR_PLAN, w().boolean(true).int32(-1).string(rows.join('\r') + '\r').int32(0)));
  src.handle(IN(H.ROOM_USERS, roomUsers([{ id: 2, name: 'Outro', roomIndex: 1 }])));
  src.handle(IN(H.ROOM_DATA, roomData({ roomId: 99, name: 'Origem' })));
  src.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems(items)));
  for (const ws of wallSpecs) src.handle(IN(H.ROOM_WALL_ITEM_ADD, wallItemAdd(ws.id, ws.spriteId, ws.pos, ws.state)));
  src.handle(IN(H.ROOM_ENTRY_TILE, w().int32(0).int32(1).int32(2)));
  return buildRoomCopy(src.snapshot(), catalog, walls, new Date('2026-09-21T02:00:00Z'));
}

let world: World;
beforeEach(() => { world = new World(); });

describe('planPurchases / priceLine / floorPlanDiffers', () => {
  it('desconta o inventário, resolve a página pelo índice e marca o que não está à venda', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: CHAIR, x: 2, y: 1 }, { id: 3, spriteId: RARE, x: 1, y: 2 }], [{ id: '9', spriteId: POSTER, pos: ':w=0,1 l=1,1 l' }]);
    const inv = parseInventory(new PacketReader(inventory([{ id: 50, type: 'S', spriteId: CHAIR }]).bytes())).items;
    const { purchases, fromInventory } = planPurchases(copy, inv, catalog, walls, (o) => (o === 10 ? 8 : o === 900 ? 24 : null));
    expect(fromInventory).toBe(1);
    expect(purchases.map((p) => [p.kind, p.type, p.needed, p.pageId, p.blocked])).toEqual([
      ['floor', CHAIR, 1, 8, null],
      ['wall', POSTER, 1, 24, null],
      ['floor', RARE, 1, null, 'não está à venda no catálogo'],
    ]);
    const page = parseCatalogPage(new PacketReader(catalogPage(8, [
      { offerId: 4984, name: 'Pacote com cadeira', credits: 20, products: [{ type: 's', spriteId: CHAIR, count: 1 }, { type: 's', spriteId: 777 }] },
      { offerId: 4985, name: 'Cadeira', credits: 3, products: [{ type: 's', spriteId: CHAIR, count: 2 }] },
    ]).bytes()));
    expect(purchases[0].furniOfferId).toBe(10); // oferta do furnidata (chave do índice)
    priceLine(purchases[0], findOffer(page, 'floor', CHAIR), 'floor');
    expect(purchases[0]).toMatchObject({ offerId: 4985, credits: 3, unitsPerOffer: 2, quantity: 1 }); // a oferta da página, só com a cadeira e mais barata
    priceLine(purchases[1], findOffer(page, 'wall', POSTER), 'wall');
    expect(purchases[1].blocked).toMatch(/nenhuma oferta/);
    expect(firstFloorTile(['xxxx', 'xx0x'])).toEqual({ x: 2, y: 1, direction: 2 });
  });

  it('floorPlanDiffers compara linhas e porta', () => {
    const copy = copyFrom([]);
    expect(floorPlanDiffers(copy, world.state.snapshot())).toBe(false); // mesmas linhas; a porta do destino ainda é desconhecida, então não conta
    world.state.handle(IN(H.ROOM_ENTRY_TILE, w().int32(0).int32(1).int32(2)));
    expect(floorPlanDiffers(copy, world.state.snapshot())).toBe(false);
    world.state.handle(IN(H.ROOM_ENTRY_TILE, w().int32(0).int32(2).int32(2)));
    expect(floorPlanDiffers(copy, world.state.snapshot())).toBe(true);
    expect(formatHeight(2)).toBe('2');
    expect(formatHeight(1.25)).toBe('1.25');
  });
});

describe('mismatchOf', () => {
  it('compara altura (tolerância), rotação e estado numérico simples', () => {
    const want = { id: 1, type: CHAIR, name: null, x: 1, y: 1, direction: 2, z: 1.5, stackHeight: 1, state: '1', dataKind: 0, extra: 0, offerId: null };
    const cur = { id: 9, spriteId: CHAIR, x: 1, y: 1, direction: 0, z: 1.501, stackHeight: 1, extra: 0, dataKind: 0, state: '0', expires: -1, usagePolicy: 0, ownerId: 1 };
    expect(mismatchOf(cur, want)).toEqual({ position: false, z: true, direction: true, state: true }); // 1.501 ≠ 1.5 ao milésimo
    expect(mismatchOf({ ...cur, z: 1.5, direction: 2, state: '1' }, want)).toEqual({ position: false, z: false, direction: false, state: false });
    expect(mismatchOf({ ...cur, x: 3 }, want).position).toBe(true);
    expect(formatHeight(0.001)).toBe('0.001');
    expect(formatHeight(3.0976)).toBe('3.098');
    expect(mismatchOf(cur, { ...want, dataKind: 2, state: 'abc' }).state).toBe(false); // estado não numérico não é ajustável
  });
});

describe('limite de 100 por compra', () => {
  it('483 unidades viram 100, 100, 100, 100 e 83; a prévia conta as chamadas', () => {
    const line: PurchaseLine = { kind: 'floor', type: CHAIR, name: 'ktchn10_block', needed: 483, furniOfferId: 10, offerId: 4985, pageId: 8, credits: 1, points: 0, pointsType: 0, unitsPerOffer: 1, extra: '', quantity: 483, blocked: null };
    const parts = splitPurchases([line, { ...line, type: 777, quantity: 7 }]);
    expect(parts.map((p) => p.quantity)).toEqual([100, 100, 100, 100, 83, 7]);
    expect(parts.every((p) => p.offerId === 4985 || p.type === 777)).toBe(true);
    expect(purchaseCalls([line])).toBe(5);
    expect(purchaseCalls([{ ...line, quantity: 100 }])).toBe(1);
  });

  it('o motor compra a mesma oferta em partes e soma as unidades no relatório', () => {
    const items = [] as { id: number; spriteId: number; x: number; y: number }[];
    for (let i = 0; i < 120; i++) items.push({ id: 100 + i, spriteId: CHAIR, x: 1 + (i % 2), y: 1 + Math.floor(i / 2) });
    const copy = copyFrom(items);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10] }]), world.now));
    world.state.handle(IN(H.CATALOG_PAGE, catalogPage(8, [{ offerId: 4985, name: 'Cadeira', credits: 1, products: [{ type: 's', spriteId: CHAIR }] }]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, placeItems: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.plan!.totalCredits).toBe(120);
    world.engine.confirm();
    for (let i = 0; i < 40 && world.engine.phase === 'buying' || world.engine.phase === 'preview'; i++) {
      world.run(300);
      // o servidor confirma cada compra
      const sent = world.sent(O.PURCHASE);
      if (sent.length > world.confirmedPurchases) {
        world.confirmedPurchases = sent.length;
        world.state.handle(IN(H.PURCHASE_OK, w().int32(4985).string('Cadeira'), world.now));
      }
      if (world.sent(O.GET_INVENTORY).length >= 2) world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    }
    const qtys = world.sent(O.PURCHASE).map((p) => { const r = p.reader(); r.int32(); r.int32(); r.string(); return r.int32(); });
    expect(qtys).toEqual([100, 20]);
    expect(world.engine.report.purchased).toBe(120);
  });
});

describe('lista de ignorados', () => {
  it('casa por prefixo, nome exato ou id do tipo, sem maiúsculas', () => {
    expect(isIgnored(['wf_'], 1, 'wf_trg_user_performs_action')).toBe(true);
    expect(isIgnored(['WF_'], 1, 'wf_cstm_enable')).toBe(true);
    expect(isIgnored(['chair_plasto'], 1, 'chair_plasto')).toBe(true);
    expect(isIgnored(['chair_plasto'], 1, 'chair_plasto_big')).toBe(true); // prefixo
    expect(isIgnored(['1001'], 1001, null)).toBe(true);
    expect(isIgnored(['wf_', ''], 1, 'chair')).toBe(false);
    expect(isIgnored([], 1, 'wf_x')).toBe(false);
  });

  it('withoutIgnored tira os mobis e refaz a lista de compras; o motor não compra nem coloca o ignorado', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: 777, x: 2, y: 2 }]);
    const { copy: f, ignored } = withoutIgnored(copy, ['floor_thing']);
    expect(ignored).toBe(1);
    expect(f.floorItems.map((i) => i.type)).toEqual([CHAIR]);
    expect(f.shopping.map((l) => l.type)).toEqual([CHAIR]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10, 70] }]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50, ignore: ['floor_thing'] }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.plan!.purchases).toEqual([]); // a cadeira vem do inventário; o floor_thing foi ignorado
    expect(world.engine.report.ignored).toBe(1);
    world.engine.confirm();
    for (let i = 0; i < 40 && world.engine.phase !== 'done'; i++) { world.run(120); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.PLACE_OBJECT).map((p) => p.reader().string())).toEqual(['50 1 1 0']);
  });
});

describe('RoomPasteEngine', () => {
  it('recusa fora de quarto próprio', () => {
    const w2 = new World(false);
    w2.engine.start(copyFrom([]), {}, w2.tick());
    expect(w2.engine.phase).toBe('error');
    expect(w2.engine.status).toMatch(/não é seu/);
  });

  it('fluxo completo: inventário, índice, preços, prévia, compra, planta, colocação, altura, estado e parede', () => {
    const copy = copyFrom(
      [
        { id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2, state: '1' },
        { id: 2, spriteId: CHAIR, x: 2, y: 1, z: 1.5 },
        { id: 3, spriteId: RARE, x: 1, y: 2 },
      ],
      [{ id: '9', spriteId: POSTER, pos: ':w=0,1 l=1,1 l', state: '1' }],
      ['xxxx', 'x00x', 'x00x', 'x00x', 'xxxx'],
    );
    world.engine.start(copy, { paceMs: 100 }, world.tick());
    expect(world.engine.phase).toBe('loading');
    expect(world.sent(O.GET_INVENTORY)).toHaveLength(1);
    expect(world.sent(O.GET_CATALOG_INDEX)).toHaveLength(1);
    // servidor: inventário com uma cadeira e o índice
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'hc', offers: [10] }, { pageId: 24, name: 'janelas', offers: [900] }]), world.now));
    world.run(200);
    expect(world.engine.phase).toBe('pricing');
    world.run(200);
    expect(world.sent(O.GET_CATALOG_PAGE).map((p) => p.reader().int32())).toEqual([8]);
    world.state.handle(IN(H.CATALOG_PAGE, catalogPage(8, [{ offerId: 4985, name: 'Cadeira', credits: 3, products: [{ type: 's', spriteId: CHAIR }] }]), world.now));
    world.run(200);
    expect(world.sent(O.GET_CATALOG_PAGE).map((p) => p.reader().int32())).toEqual([8, 24]);
    world.state.handle(IN(H.CATALOG_PAGE, catalogPage(24, [{ offerId: 7000, name: 'Poster', credits: 2, products: [{ type: 'i', spriteId: POSTER, extra: '0' }] }]), world.now));
    world.run(200);
    world.run(200);
    expect(world.engine.phase).toBe('preview');
    const plan = world.engine.plan!;
    expect(plan.fromInventory).toBe(1);
    expect(plan.totalCredits).toBe(5); // 1 cadeira (3) + 1 poster (2)
    expect(plan.unpurchasable).toBe(1); // o raro
    expect(plan.floorPlanChanges).toBe(true);
    expect(world.sent(O.PURCHASE)).toHaveLength(0); // nada comprado antes da confirmação

    world.engine.confirm();
    world.run(100);
    expect(world.engine.phase).toBe('buying');
    world.run(100);
    let buys = world.sent(O.PURCHASE).map((p) => { const r = p.reader(); return [r.int32(), r.int32(), r.string(), r.int32()]; });
    expect(buys).toEqual([[8, 4985, '', 1]]); // compra pela oferta DA PÁGINA, não pela do furnidata
    world.state.handle(IN(H.PURCHASE_OK, w().int32(4985).string('Cadeira'), world.now));
    world.run(100);
    world.run(1000); // respiro entre compras
    world.run(100);
    buys = world.sent(O.PURCHASE).map((p) => { const r = p.reader(); return [r.int32(), r.int32(), r.string(), r.int32()]; });
    expect(buys[1]).toEqual([24, 7000, '0', 1]);
    world.state.handle(IN(H.PURCHASE_OK, w().int32(7000).string('Poster'), world.now));
    world.run(100);
    world.run(1000);
    world.run(100);
    expect(world.sent(O.GET_INVENTORY)).toHaveLength(2); // recarrega o inventário
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }, { id: 51, type: 'S', spriteId: CHAIR }, { id: 52, type: 'I', spriteId: POSTER }]), world.now));
    world.run(200);
    expect(world.engine.phase).toBe('floorplan');
    const saved = world.sent(O.SAVE_FLOOR_PLAN)[0].reader();
    expect(saved.string()).toBe(standardFloorRows().join('\r')); // planta de obra: piso padrão 64×64 (o JSON só tem zeros por cima)
    expect([saved.int32(), saved.int32(), saved.int32()]).toEqual([63, 63, 2]); // porta da obra fixa no canto
    expect([saved.int32(), saved.int32(), saved.int32()]).toEqual([0, 0, 15]); // espessuras e parede máxima (16 o servidor descarta)
    // servidor: aviso e reentrada com a planta nova
    world.state.handle(IN(H.SERVER_NOTICE, w().string('Seu quarto foi modificado'), world.now));
    world.enter(10, true, standardFloorRows());
    world.state.handle(IN(H.ROOM_ENTRY_TILE, w().int32(0).int32(1).int32(2), world.now));
    world.run(2000);
    expect(world.engine.phase).toBe('placing');

    // colocação: o servidor responde a cada mobi, mas ignora a rotação pedida (como visto ao vivo);
    // cada mobi é conferido ao aparecer e corrigido num só movimento antes do próximo
    world.ignoreDirection = true;
    for (let i = 0; i < 80 && world.engine.phase === 'placing'; i++) {
      world.run(150);
      world.serverPlaces();
      world.serverMoves();
      const uses = world.sent(O.USE_WALL_ITEM).length;
      if (uses > world.wallUses) {
        world.wallUses = uses;
        const cur = world.state.snapshot().room.wallItems[0];
        world.state.handle(IN(H.ROOM_WALL_ITEM_UPDATE, wallItemAdd(cur.id, cur.spriteId, cur.wallPosition, String((parseInt(cur.state, 10) + 1) % 2)), world.now));
      }
    }
    expect(world.engine.phase).toBe('verifying');
    const placesSpec = world.sent(O.PLACE_OBJECT).map((p) => p.reader().string());
    expect(placesSpec[0]).toBe('50 1 1 2'); // no piso e casa livre: direto
    expect(placesSpec[1].startsWith('51 ') && placesSpec[1] !== '51 2 1 0').toBe(true); // altura 1.5: casa de apoio, depois :up + mover
    expect(placesSpec[2]).toBe('52 :w=0,1 l=1,1 l ');
    expect(world.engine.report).toMatchObject({ placedFloor: 2, placedWall: 1, missingFloor: 1, fixedOnPlace: 3 }); // o raro não tem no inventário; 3 ajustes = 2 cadeiras + 1 pôster
    // cadeira 50: rotação 2 + estado 1 num só movimento; cadeira 51: altura 1.5 (rotação 0 já batia)
    const chats = world.sent(O.CHAT).map((p) => p.reader().string());
    expect(chats).toEqual([':state 1', ':state 0', ':up 1.5', ':up', ':state']); // estado armado ANTES de cada colocação; :up no mover; tudo desligado antes da parede
    const moves = world.sent(O.MOVE_OBJECT).map((p) => { const r = p.reader(); return [r.int32(), r.int32(), r.int32(), r.int32()]; });
    expect(moves).toEqual([[50, 1, 1, 2], [51, 2, 1, 0]]);
    // verificação final: nada sobrou; pintura: nada a aplicar; depois a planta real do JSON
    for (let i = 0; i < 12 && world.engine.phase !== 'floorplan-final'; i++) world.run(200);
    expect(world.engine.phase).toBe('floorplan-final');
    const room = world.state.snapshot().room;
    expect(room.floorItems.find((f) => f.id === 51)?.z).toBe(1.5);
    expect(room.floorItems.find((f) => f.id === 50)).toMatchObject({ state: '1', direction: 2 });
    expect(room.wallItems[0].state).toBe('1');
    expect(world.sent(O.SAVE_FLOOR_PLAN)).toHaveLength(2);
    const finalSave = world.sent(O.SAVE_FLOOR_PLAN)[1].reader();
    expect(finalSave.string()).toBe('xxxx\rx00x\rx00x\rx00x\rxxxx'); // a planta real, com a porta e a altura de parede do JSON
    expect([finalSave.int32(), finalSave.int32(), finalSave.int32()]).toEqual([0, 1, 2]);
    finalSave.int32(); finalSave.int32();
    expect(finalSave.int32()).toBe(-1);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'x00x', 'xxxx'], world.keptItems());
    for (let i = 0; i < 20 && world.engine.phase !== 'done'; i++) world.run(500);
    expect(world.engine.phase).toBe('done');
    expect(world.engine.report).toMatchObject({ fixedOnPlace: 3, fixedOnVerify: 0, failed: 0, purchased: 2, lostOnFloorPlan: 0, movedOnFloorPlan: 0 });
    expect(world.logs.some((l) => /veio com rotação 0 → 2/.test(l))).toBe(true); // o estado 1 já nasceu certo (armado antes do 1258)
  });

  it('dois mobis na mesma casa: o segundo vai por casa de apoio e chega com altura, rotação e estado num só movimento', () => {
    const copy = copyFrom([
      { id: 1, spriteId: CHAIR, x: 1, y: 1, z: 0, state: '0' },
      { id: 2, spriteId: CHAIR, x: 1, y: 1, z: 0.001, direction: 4, state: '1' },
      { id: 3, spriteId: CHAIR, x: 2, y: 2, z: 1.3 },
    ]);
    expect(copy.floorItems).toHaveLength(3); // nada é deduplicado por coordenada
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }, { id: 51, type: 'S', spriteId: CHAIR }, { id: 52, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    world.engine.confirm();
    for (let i = 0; i < 120 && world.engine.phase !== 'done'; i++) {
      world.run(120);
      world.serverPlaces();
      world.serverMoves();
    }
    expect(world.engine.phase).toBe('done');
    const places = world.sent(O.PLACE_OBJECT).map((p) => p.reader().string());
    expect(places[0]).toBe('50 1 1 0'); // primeiro direto
    expect(places[1]).not.toBe('51 1 1 4'); // segundo numa casa de apoio livre
    expect(places[2]).not.toBe('52 2 2 0'); // altura 1.3 acima do piso: também por casa de apoio
    const moves = world.sent(O.MOVE_OBJECT).map((p) => { const r = p.reader(); return [r.int32(), r.int32(), r.int32(), r.int32()]; });
    expect(moves).toEqual([[51, 1, 1, 4], [52, 2, 2, 0]]);
    const chats = world.sent(O.CHAT).map((p) => p.reader().string());
    expect(chats).toEqual([':state 1', ':up 0.001', ':state 0', ':up 1.3', ':up', ':state']);
    const room = world.state.snapshot().room;
    expect(room.floorItems.filter((f) => f.x === 1 && f.y === 1).map((f) => [f.id, f.z, f.direction, f.state])).toEqual([[50, 0, 0, '0'], [51, 0.001, 4, '1']]);
    expect(room.floorItems.find((f) => f.id === 52)).toMatchObject({ x: 2, y: 2, z: 1.3 });
    expect(world.engine.report).toMatchObject({ placedFloor: 3, staged: 2, failed: 0 });
    expect(findStagingTile(world.state.snapshot(), catalog, copy.floorItems[0])).not.toBeNull();
  });

  it('planta de obra = exatamente o piso padrão em 0; :up leva as alturas do JSON; a planta real vai no fim e os mobis são conferidos', () => {
    // (1,1) é um lote de altura 2 com uma cadeira apoiada (z 2) e outra em cima (z 2.001);
    // (2,1) não tem chão na planta real, mas tem uma cadeira flutuando em 2.5 (piso tirado depois de decorar).
    const rows = ['xxxx', 'x2xx', 'x00x', 'xxxx'];
    const copy = copyFrom([
      { id: 1, spriteId: CHAIR, x: 1, y: 1, z: 2 },
      { id: 2, spriteId: CHAIR, x: 1, y: 1, z: 2.001, state: '1' },
      { id: 3, spriteId: CHAIR, x: 2, y: 1, z: 2.5 },
    ], [], rows);
    const build = buildFloorPlan(copy, catalog)!;
    expect(build.rows).toHaveLength(64);
    expect(build.rows[0]).toBe('0'.repeat(64));
    expect(build.rows[1]).toBe('0'.repeat(64)); // exatamente o piso padrão: o lote 2 do JSON NÃO entra na obra
    expect(build).toMatchObject({ opened: 1, outside: 0, wallHeight: 15 });
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }, { id: 51, type: 'S', spriteId: CHAIR }, { id: 52, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    world.engine.confirm();
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('floorplan');
    expect(world.sent(O.SAVE_FLOOR_PLAN)[0].reader().string()).toBe(build.rows.join('\r')); // planta de obra
    world.enter(10, true, build.rows);
    world.run(2000);
    expect(world.engine.phase).toBe('placing');
    for (let i = 0; i < 120 && world.engine.phase === 'placing' || world.engine.phase === 'verifying' || world.engine.phase === 'paint'; i++) {
      world.run(120);
      world.serverPlaces();
      world.serverMoves();
    }
    expect(world.engine.phase).toBe('floorplan-final');
    const places = world.sent(O.PLACE_OBJECT).map((p) => p.reader().string());
    expect(places[0]).not.toBe('50 1 1 0'); // sobre o piso 0 da obra, a cadeira em z 2 vai por casa de apoio
    const chats = world.sent(O.CHAT).map((p) => p.reader().string());
    expect(chats).toEqual([':up 2', ':state 1', ':up 2.001', ':state 0', ':up 2.5', ':up', ':state']); // piso da obra é 0: :up leva a altura absoluta do JSON
    let room = world.state.snapshot().room;
    expect(room.floorItems.map((f) => [f.id, f.x, f.y, f.z])).toEqual([[50, 1, 1, 2], [51, 1, 1, 2.001], [52, 2, 1, 2.5]]);
    expect(world.engine.report).toMatchObject({ placedFloor: 3, staged: 3, failed: 0 });
    // planta final: a real, que fecha (2,1); o servidor recolhe o mobi que ficou sem chão
    expect(world.sent(O.SAVE_FLOOR_PLAN)).toHaveLength(2);
    expect(world.sent(O.SAVE_FLOOR_PLAN)[1].reader().string()).toBe(rows.join('\r'));
    world.enter(10, true, rows, world.keptItems((f) => f.x === 2 && f.y === 1));
    for (let i = 0; i < 40 && world.engine.phase !== 'done'; i++) world.run(500);
    expect(world.engine.phase).toBe('done');
    expect(world.engine.report).toMatchObject({ lostOnFloorPlan: 1, movedOnFloorPlan: 0 });
    expect(world.logs.some((l) => /1 mobi\(s\) colocado\(s\) sumiram/.test(l))).toBe(true);
    room = world.state.snapshot().room;
    expect(room.floorItems.map((f) => f.id)).toEqual([50, 51]);
  });

  it('se o servidor tratar :up como altura absoluta, o motor percebe no primeiro ajuste que estoura o prazo e troca', () => {
    world.enter(10, true, ['xxxx', 'x2xx', 'x00x', 'xxxx']);
    world.upAbsolute = true;
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, z: 2.5 }], [], ['xxxx', 'x2xx', 'x00x', 'xxxx']);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 200 && world.engine.phase !== 'done'; i++) {
      world.run(120);
      world.serverPlaces();
      world.serverMoves();
    }
    expect(world.engine.phase).toBe('done');
    const chats = world.sent(O.CHAT).map((p) => p.reader().string());
    expect(chats).toEqual([':up 0.5', ':up 2.5', ':up']); // relativo (0.5) ficou em 0.5 → absoluto (2.5)
    expect(world.state.snapshot().room.floorItems[0]).toMatchObject({ x: 1, y: 1, z: 2.5 });
    expect(world.engine.report).toMatchObject({ placedFloor: 1, staged: 1, failed: 0 });
    expect(world.logs.some((l) => /altura absoluta/.test(l))).toBe(true);
  });

  it('se o estado vier errado mesmo armado, o motor usa o mobi (99) até bater e conta um ajuste só', () => {
    world.ignoreStateOnPlace = true;
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, state: '1' }, { id: 2, spriteId: CHAIR, x: 2, y: 2, z: 1.5, state: '1' }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }, { id: 51, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 200 && world.engine.phase !== 'done'; i++) {
      world.run(120);
      world.serverPlaces();
      world.serverMoves();
      world.serverUses();
    }
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.CHAT).map((p) => p.reader().string())).toEqual([':state 1', ':up 1.5', ':up', ':state']); // armado antes; nunca um :state para corrigir
    expect(world.sent(O.USE_OBJECT).map((p) => p.reader().int32())).toEqual([50, 51]); // um "usar" por mobi
    const room = world.state.snapshot().room;
    expect(room.floorItems.map((f) => [f.id, f.z, f.state])).toEqual([[50, 0, '1'], [51, 1.5, '1']]);
    expect(world.engine.report).toMatchObject({ placedFloor: 2, staged: 1, fixedOnPlace: 2, failed: 0 }); // o 51 teve mover + usar, mas conta uma vez
  });

  it('planta de obra não confirmada em 20 s: para com erro em vez de colocar às cegas', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('floorplan');
    expect(world.sent(O.SAVE_FLOOR_PLAN)).toHaveLength(1);
    world.run(21_000); // o servidor não respondeu
    expect(world.engine.phase).toBe('error');
    expect(world.engine.status).toMatch(/planta de obra não foi confirmada/);
    expect(world.sent(O.PLACE_OBJECT)).toHaveLength(0);
  });

  it('cancelar no meio desliga o modo :up', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, z: 2 }]);
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    world.engine.confirm();
    world.run(100);
    world.run(100);
    world.run(100);
    world.serverPlaces();
    world.run(100);
    world.run(100);
    world.run(500);
    expect(world.sent(O.CHAT).map((p) => p.reader().string())).toEqual([':up 2']);
    world.engine.cancel(world.tick());
    expect(world.engine.phase).toBe('cancelled');
    expect(world.sent(O.CHAT).map((p) => p.reader().string())).toEqual([':up 2', ':up']);
  });
});

describe('continuar construção', () => {
  /** Duas cadeiras já colocadas (uma torta) de um JSON de três: o caso de uma queda no meio da colagem. */
  function interrupted() {
    const copy = copyFrom([
      { id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2 },
      { id: 2, spriteId: CHAIR, x: 2, y: 1 },
      { id: 3, spriteId: CHAIR, x: 1, y: 2 },
    ]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [
      { id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 0 }, // veio torta antes da queda
      { id: 901, spriteId: CHAIR, x: 2, y: 1, direction: 0 },
    ]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10] }]), world.now));
    world.state.handle(IN(H.CATALOG_PAGE, catalogPage(8, [{ offerId: 4985, name: 'Cadeira', credits: 3, products: [{ type: 's', spriteId: CHAIR }] }]), world.now));
    return copy;
  }

  it('matchPlaced casa por tipo + casa, pega a altura mais próxima na pilha e conta as sobras', () => {
    const copy = copyFrom(
      [
        { id: 1, spriteId: CHAIR, x: 1, y: 1, z: 0 },
        { id: 2, spriteId: CHAIR, x: 1, y: 1, z: 0.001 },
        { id: 3, spriteId: CHAIR, x: 2, y: 2 },
        { id: 4, spriteId: RARE, x: 2, y: 1 },
      ],
      [{ id: '9', spriteId: POSTER, pos: ':w=0,1 l=1,1 l' }],
    );
    // No quarto: a pilha de (1,1) inteira (na ordem trocada), uma cadeira sobrando numa casa de apoio e o pôster.
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [
      { id: 900, spriteId: CHAIR, x: 1, y: 1, z: 0.001 },
      { id: 901, spriteId: CHAIR, x: 1, y: 1, z: 0 },
      { id: 902, spriteId: CHAIR, x: 1, y: 2 },
    ]);
    world.state.handle(IN(H.ROOM_WALL_ITEM_ADD, wallItemAdd('950', POSTER, ':w=0,1 l=1,1 l'), world.now));
    const m = matchPlaced(copy, world.state.snapshot());
    expect(m.floorMatched.map((f) => [f.want.z, f.itemId])).toEqual([[0, 901], [0.001, 900]]); // cada um com o da sua altura
    expect(m.floorMissing.map((i) => [i.type, i.x, i.y])).toEqual([[RARE, 2, 1], [CHAIR, 2, 2]]);
    expect(m.wallMatched.map((wm) => wm.itemId)).toEqual(['950']);
    expect(m.wallMissing).toEqual([]);
    expect(m.strays).toBe(1); // a cadeira de (1,2) não é de nenhuma posição do JSON: fica onde está
  });

  it('matchPlaced ignora rotação, altura e estado ao casar (o mobi existe; a verificação final o acerta)', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2, z: 1.5, state: '1' }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 0, z: 0, state: '0' }]);
    const m = matchPlaced(copy, world.state.snapshot());
    expect(m.floorMatched.map((f) => f.itemId)).toEqual([900]);
    expect(m.floorMissing).toEqual([]);
    expect(mismatchOf(world.state.snapshot().room.floorItems[0], copy.floorItems[0])).toMatchObject({ z: true, direction: true, state: true });
  });

  it('o motor não recompra nem recoloca o que já está no quarto, e a verificação final endireita o que ficou torto', () => {
    const copy = interrupted();
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now)); // tudo que foi comprado antes já está no quarto
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.report).toMatchObject({ resumedFloor: 2, resumedWall: 0, strays: 0 });
    expect(world.engine.plan!.purchases.map((p) => [p.type, p.needed])).toEqual([[CHAIR, 1]]); // só a que falta, não as 3
    expect(world.engine.plan!.totalCredits).toBe(3);
    expect(world.logs.some((l) => /continuando: 2 mobi\(s\) de chão/.test(l))).toBe(true);

    world.engine.confirm();
    for (let i = 0; i < 60 && world.engine.phase !== 'done'; i++) {
      world.run(120);
      if (world.sent(O.PURCHASE).length > world.confirmedPurchases) {
        world.confirmedPurchases = world.sent(O.PURCHASE).length;
        world.state.handle(IN(H.PURCHASE_OK, w().int32(4985).string('Cadeira'), world.now));
      }
      if (world.sent(O.GET_INVENTORY).length >= 2) world.state.handle(IN(H.INVENTORY, inventory([{ id: 60, type: 'S', spriteId: CHAIR }]), world.now));
      world.serverPlaces();
      world.serverMoves();
    }
    expect(world.engine.phase).toBe('done');
    const buys = world.sent(O.PURCHASE).map((p) => { const r = p.reader(); r.int32(); r.int32(); r.string(); return r.int32(); });
    expect(buys).toEqual([1]); // uma compra, de uma unidade
    expect(world.sent(O.PLACE_OBJECT).map((p) => p.reader().string())).toEqual(['60 1 2 0']); // só a que faltava
    expect(world.sent(O.MOVE_OBJECT).map((p) => { const r = p.reader(); return [r.int32(), r.int32(), r.int32(), r.int32()]; })).toEqual([[900, 1, 1, 2]]); // endireita a torta
    expect(world.engine.report).toMatchObject({ resumedFloor: 2, placedFloor: 1, purchased: 1, fixedOnVerify: 1, failed: 0, missingFloor: 0 });
    const room = world.state.snapshot().room;
    expect(room.floorItems.map((f) => [f.id, f.x, f.y, f.direction])).toEqual([[900, 1, 1, 2], [901, 2, 1, 0], [60, 1, 2, 0]]);
  });

  it('quarto já pronto: vira só uma passada de conferência, sem comprar nem colocar nada', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: CHAIR, x: 2, y: 1 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [
      { id: 900, spriteId: CHAIR, x: 1, y: 1 },
      { id: 901, spriteId: CHAIR, x: 2, y: 1 },
    ]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10] }]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.plan!.purchases).toEqual([]);
    world.engine.confirm();
    for (let i = 0; i < 40 && world.engine.phase !== 'done'; i++) { world.run(120); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.PURCHASE)).toHaveLength(0);
    expect(world.sent(O.PLACE_OBJECT)).toHaveLength(0);
    expect(world.sent(O.MOVE_OBJECT)).toHaveLength(0);
    expect(world.engine.report).toMatchObject({ resumedFloor: 2, placedFloor: 0, purchased: 0, fixedOnVerify: 0, failed: 0 });
  });

  it('cenário real: caiu no meio da colocação (quarto na planta de obra) — retoma, compra só o que falta e salva a planta real no fim', () => {
    const copy = copyFrom([
      { id: 1, spriteId: CHAIR, x: 1, y: 1 },
      { id: 2, spriteId: CHAIR, x: 2, y: 1 },
      { id: 3, spriteId: CHAIR, x: 1, y: 2 },
    ]);
    // O quarto ficou como a queda o deixou: planta de obra salva e dois mobis já colocados.
    world.enter(10, true, standardFloorRows(), [
      { id: 900, spriteId: CHAIR, x: 1, y: 1 },
      { id: 901, spriteId: CHAIR, x: 2, y: 1 },
    ]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10] }]), world.now));
    world.state.handle(IN(H.CATALOG_PAGE, catalogPage(8, [{ offerId: 4985, name: 'Cadeira', credits: 3, products: [{ type: 's', spriteId: CHAIR }] }]), world.now));
    world.engine.start(copy, { paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 60, type: 'S', spriteId: CHAIR }]), world.now)); // a que faltava já tinha sido comprada
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.report.resumedFloor).toBe(2);
    expect(world.engine.plan!.purchases).toEqual([]); // a última vem do inventário: nada a comprar

    world.engine.confirm();
    for (let i = 0; i < 60 && world.engine.phase !== 'floorplan-final'; i++) { world.run(120); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('floorplan-final');
    expect(world.sent(O.PLACE_OBJECT).map((p) => p.reader().string())).toEqual(['60 1 2 0']);
    // a planta de obra já estava salva: o único 875 é o da planta real do JSON, no fim
    expect(world.sent(O.SAVE_FLOOR_PLAN)).toHaveLength(1);
    expect(world.sent(O.SAVE_FLOOR_PLAN)[0].reader().string()).toBe('xxxx\rx00x\rx00x\rxxxx');
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], world.keptItems());
    for (let i = 0; i < 30 && world.engine.phase !== 'done'; i++) world.run(500);
    expect(world.engine.phase).toBe('done');
    expect(world.engine.report).toMatchObject({ resumedFloor: 2, placedFloor: 1, purchased: 0, failed: 0, lostOnFloorPlan: 0, movedOnFloorPlan: 0 });
    expect(world.state.snapshot().room.floorItems.map((f) => f.id).sort((a, b) => a - b)).toEqual([60, 900, 901]);
  });

  it('com "continuar" desligado, o motor não olha o quarto e refaz a compra inteira', () => {
    const copy = interrupted();
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50, resume: false }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('preview');
    expect(world.engine.plan!.purchases.map((p) => [p.type, p.needed])).toEqual([[CHAIR, 3]]);
    expect(world.engine.report).toMatchObject({ resumedFloor: 0, resumedWall: 0, strays: 0 });
  });

  it('continuando, a pintura que já está aplicada não é reaplicada', () => {
    const copy = copyFrom([]);
    copy.paint = { floor: '111' };
    world.state.handle(IN(H.ROOM_PAINT, w().string('floor').string('111'), world.now));
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 70, type: 'I', spriteId: 5000, state: '111' }]), world.now));
    world.run(100);
    world.run(100);
    expect(world.engine.plan!.paint).toEqual([]); // já está assim
    world.engine.confirm();
    for (let i = 0; i < 30 && world.engine.phase !== 'done'; i++) world.run(120);
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.APPLY_DECORATION)).toHaveLength(0);
  });
});

describe('refino depois da planta final', () => {
  it('a planta final reassenta os mobis e o refino os acerta (antes isso só era relatado)', () => {
    // (1,1) é um lote de altura 2 na planta real; na obra o piso é 0 e a cadeira é colocada em z 2 com :up.
    const rows = ['xxxx', 'x2xx', 'x00x', 'xxxx'];
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, z: 2 }], [], rows);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    world.run(100);
    world.run(100);
    expect(world.engine.phase).toBe('floorplan');
    world.enter(10, true, standardFloorRows()); // planta de obra aplicada
    world.run(2000);
    for (let i = 0; i < 60 && world.engine.phase !== 'floorplan-final'; i++) { world.run(120); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('floorplan-final');
    expect(world.state.snapshot().room.floorItems[0]).toMatchObject({ id: 50, z: 2 }); // certo sobre o piso da obra

    // A planta real sobe o piso de (1,1) para 2 e o servidor reassenta a cadeira em cima dele: z 4.
    world.enter(10, true, rows, [{ id: 50, spriteId: CHAIR, x: 1, y: 1, z: 4, stackHeight: 1, state: '0', direction: 0 }]);
    for (let i = 0; i < 60 && world.engine.phase !== 'done'; i++) { world.run(300); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.engine.report.movedOnFloorPlan).toBe(1); // detectado…
    expect(world.engine.report.fixedOnFinal).toBe(1); // …e AGORA consertado
    expect(world.engine.report.stillWrong).toBe(0);
    expect(world.state.snapshot().room.floorItems[0]).toMatchObject({ id: 50, x: 1, y: 1, z: 2 }); // de volta à altura do JSON
    // :up relativo ao piso real (2) para chegar em z 2 → :up 0
    expect(world.sent(O.CHAT).map((p) => p.reader().string())).toContain(':up 0');
  });

  it('o refino tenta de novo quando o servidor ignora a rotação, em vez de desistir na primeira', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 0 }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.dropMoveDirection = 1; // o servidor ignora a rotação do primeiro mover
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 80 && world.engine.phase !== 'done'; i++) { world.run(500); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.MOVE_OBJECT)).toHaveLength(2); // primeira ignorada, segunda aceita
    expect(world.state.snapshot().room.floorItems[0]).toMatchObject({ id: 900, direction: 2 });
    expect(world.engine.report).toMatchObject({ fixedOnVerify: 1, failed: 0, stillWrong: 0 });
    expect(world.logs.some((l) => /tentativa 2 de 3/.test(l))).toBe(true);
  });

  it('desiste depois das tentativas das duas passadas e diz quantos ficaram diferentes', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 0 }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.dropMoveDirection = 99; // o servidor nunca aceita a rotação
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 200 && world.engine.phase !== 'done'; i++) { world.run(500); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    // 3 tentativas na verificação + 3 no refino: a passada de depois da planta tenta de novo de propósito,
    // porque o mundo mudou no meio (o piso é outro) e um ajuste que falhou antes pode passar agora.
    expect(world.sent(O.MOVE_OBJECT)).toHaveLength(2 * MAX_FIX_ATTEMPTS);
    expect(world.state.snapshot().room.floorItems[0].direction).toBe(0); // o servidor nunca cedeu
    expect(world.engine.report).toMatchObject({ fixedOnVerify: 0, fixedOnFinal: 0, stillWrong: 1, auditOk: 0, auditMissing: 0 });
    // A conferência final aponta o problema pela coordenada, não só uma contagem.
    expect(world.engine.audit!.fixable).toBe(1);
    expect(world.engine.audit!.floor[0].verdicts).toEqual(['wrong-direction']);
    expect(world.engine.audit!.floor[0].detail).toMatch(/rotação 0 → 2/);
    expect(world.logs.some((l) => /conferência \[wrong-direction\]/.test(l))).toBe(true);
  });

  it('quarto pronto e planta igual: nenhuma planta é salva (nem a de obra), só a conferência', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: CHAIR, x: 2, y: 1 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [
      { id: 900, spriteId: CHAIR, x: 1, y: 1 },
      { id: 901, spriteId: CHAIR, x: 2, y: 1 },
    ]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { paceMs: 50 }, world.tick()); // planta LIGADA
    world.state.handle(IN(H.INVENTORY, inventory([]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 40 && world.engine.phase !== 'done'; i++) { world.run(300); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.sent(O.SAVE_FLOOR_PLAN)).toHaveLength(0); // não troca o piso à toa debaixo dos mobis
    expect(world.sent(O.PLACE_OBJECT)).toHaveLength(0);
    expect(world.engine.report).toMatchObject({ resumedFloor: 2, fixedOnVerify: 0, fixedOnFinal: 0, stillWrong: 0 });
    expect(world.logs.some((l) => /planta de obra é dispensada/.test(l))).toBe(true);
  });
});

describe('conferência por coordenada (auditRoom)', () => {
  it('diz, mobi por mobi do JSON, o que está certo e o que está errado em cada casa', () => {
    const copy = copyFrom(
      [
        { id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2, state: '1' }, // vai estar certo
        { id: 2, spriteId: CHAIR, x: 2, y: 1, z: 1.5 }, // vai estar na altura errada
        { id: 3, spriteId: CHAIR, x: 1, y: 2 }, // casa vazia: falta colocar
        { id: 4, spriteId: RARE, x: 2, y: 2 }, // a casa tem outro tipo
      ],
      [{ id: '9', spriteId: POSTER, pos: ':w=0,1 l=1,1 l', state: '1' }], // parede: estado errado
    );
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [
      { id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 2, state: '1' },
      { id: 901, spriteId: CHAIR, x: 2, y: 1, z: 0 },
      { id: 902, spriteId: CHAIR, x: 2, y: 2 }, // cadeira onde o JSON quer o raro
    ]);
    world.state.handle(IN(H.ROOM_WALL_ITEM_ADD, wallItemAdd('950', POSTER, ':w=0,1 l=1,1 l', '0'), world.now));

    const a = auditRoom(copy, world.state.snapshot());
    /** A linha da conferência da casa (x, y) — a ordem da lista segue o JSON, não as coordenadas. */
    const at = (x: number, y: number) => a.floor.find((r) => r.want.x === x && r.want.y === y)!;
    expect(at(1, 1).verdicts).toEqual(['ok']);
    expect(at(2, 1).verdicts).toEqual(['wrong-z']);
    expect(at(1, 2).verdicts).toEqual(['missing']);
    expect(at(2, 2).verdicts).toEqual(['wrong-type']);
    expect(a.wall.map((r) => r.verdicts)).toEqual([['wrong-state']]);
    expect(a).toMatchObject({ ok: 1, missing: 1, wrongType: 1, fixable: 2, extraFloor: 1 });
    expect(at(2, 1).detail).toMatch(/altura 0 → 1\.5/);
    expect(at(1, 2).detail).toMatch(/\(1, 2\) está vazia/);
    expect(at(2, 2).detail).toMatch(/\(2, 2\) tem outro mobi/);
    expect(auditIsClean(a)).toBe(false);
  });

  it('com o mapa do que o motor colocou, aponta o mobi que saiu de lugar em vez de "falta um / sobra um"', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 2, y: 2 }]);
    const snap = world.state.snapshot();

    const semMapa = auditRoom(copy, snap);
    expect(semMapa.floor[0].verdicts).toEqual(['missing']);
    expect(semMapa.extraFloor).toBe(1);

    const comMapa = auditRoom(copy, snap, new Map([[copy.floorItems[0], 900]]));
    expect(comMapa.floor[0].verdicts).toContain('wrong-position');
    expect(comMapa.floor[0].detail).toMatch(/deveria estar em \(1, 1\) e está em \(2, 2\)/);
    expect(comMapa.extraFloor).toBe(0);
    expect(comMapa.fixable).toBe(1); // dá para consertar com um mover
  });

  it('quarto igual ao JSON: conferência limpa e relatório sem divergências', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 2 }]);
    const a = auditRoom(copy, world.state.snapshot());
    expect(auditIsClean(a)).toBe(true);
    expect(a.ok).toBe(1);
    const txt = auditReportText(copy, a, new Date('2026-09-21T14:00:00Z'));
    expect(txt).toMatch(/Nenhuma divergência/);
    expect(txt).toMatch(/ok 1 · falta colocar 0/);
  });

  it('o relatório lista cada divergência com a coordenada', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: CHAIR, x: 2, y: 1 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 4 }]);
    const txt = auditReportText(copy, auditRoom(copy, world.state.snapshot()));
    expect(txt).toMatch(/\[wrong-direction\].*rotação 4 → 0/);
    expect(txt).toMatch(/\[missing\].*\(2, 1\) está vazia/);
    expect(txt.split('\n').filter((l) => l.startsWith('['))).toHaveLength(2);
  });

  it('o motor confere um mobi que ele nunca colocou (a falha que o check antigo deixava passar)', () => {
    // Uma cadeira já no quarto, torta, e o JSON pede duas: a antiga NÃO está em `placements` até a
    // reconciliação — e o check antigo, que percorria só os colocados, nunca a olharia.
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2 }, { id: 2, spriteId: CHAIR, x: 2, y: 1 }]);
    world.enter(10, true, ['xxxx', 'x00x', 'x00x', 'xxxx'], [{ id: 900, spriteId: CHAIR, x: 1, y: 1, direction: 0 }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 60, type: 'S', spriteId: CHAIR }]), world.now));
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 60 && world.engine.phase !== 'done'; i++) { world.run(300); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    expect(world.state.snapshot().room.floorItems.find((f) => f.id === 900)!.direction).toBe(2); // endireitada
    const a = world.engine.audit!;
    expect(auditIsClean(a)).toBe(true);
    expect(a.ok).toBe(2);
    expect(world.engine.report).toMatchObject({ auditOk: 2, auditMissing: 0, stillWrong: 0 });
  });

  it('a conferência final acusa o mobi que faltou colocar por falta de inventário', () => {
    const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: RARE, x: 2, y: 1 }]);
    world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([]), world.now));
    world.engine.start(copy, { applyFloorPlan: false, paceMs: 50 }, world.tick());
    world.state.handle(IN(H.INVENTORY, inventory([{ id: 60, type: 'S', spriteId: CHAIR }]), world.now)); // sem o raro
    world.run(100);
    world.run(100);
    world.engine.confirm();
    for (let i = 0; i < 60 && world.engine.phase !== 'done'; i++) { world.run(300); world.serverPlaces(); world.serverMoves(); }
    expect(world.engine.phase).toBe('done');
    const a = world.engine.audit!;
    expect(a.ok).toBe(1);
    expect(a.missing).toBe(1);
    expect(a.floor.find((r) => r.verdicts.includes('missing'))!.detail).toMatch(/\(2, 1\) está vazia/);
    expect(world.engine.report).toMatchObject({ auditOk: 1, auditMissing: 1, missingFloor: 1 });
    expect(world.engine.status).toMatch(/1 de 2 mobis do JSON conferem/);
  });
});

describe('PasteSession (a colagem vive fora do cartão)', () => {
  it('sem dependências não começa; com o cartão fechado (sem assinantes) o relógio segue; só o cancelar interrompe', () => {
    vi.useFakeTimers();
    try {
      const session = new PasteSession();
      const copy = copyFrom([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }]);
      session.setCopy(copy, 'quarto.json');
      expect(session.start()).toBe(false); // App ainda não ligou as dependências
      session.bind({ state: world.state, actions: world.actions, catalog, walls, log: () => {} });
      expect(session.bound).toBe(true);
      let renders = 0;
      const unsub = session.subscribe(() => { renders++; });
      expect(session.start()).toBe(true);
      expect(session.engine.phase).toBe('loading');
      expect(renders).toBe(1);
      unsub(); // o usuário fechou o cartão
      const v = session.version;
      world.state.handle(IN(H.CATALOG_INDEX, catalogIndex([{ pageId: 8, name: 'x', offers: [10] }]), Date.now()));
      world.state.handle(IN(H.INVENTORY, inventory([{ id: 50, type: 'S', spriteId: CHAIR }]), Date.now()));
      vi.advanceTimersByTime(1000);
      expect(session.engine.active).toBe(true);
      expect(session.engine.phase).toBe('preview'); // avançou sem ninguém desenhando
      expect(session.version).toBeGreaterThan(v);
      expect(renders).toBe(1); // e sem avisar quem saiu
      expect(session.shortStatus).toBe('preview');
      session.cancel();
      expect(session.engine.active).toBe(false);
      expect(session.shortStatus).toBeNull();
      session.unbind();
      expect(session.bound).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
