import { describe, expect, it } from 'vitest';
import { PacketReader } from '../src/protocol/decode';
import { floorPlanHeight, parseFloorPlan, parseHeightMap, parseOccupiedTiles, parseRoomEntryTile, parseRoomPaint, parseWallItems } from '../src/protocol/nitro/parsers';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import { GameState } from '../src/protocol/state/GameState';
import { createGameActions } from '../src/protocol/actions';
import { buildRoomCopy, describeRoomCopy, roomCopyFileName } from '../src/protocol/roomCopy';
import type { FurniCatalog, WallCatalog } from '../shared/furnidata';
import { IN, OUT, captureSends, floorItems, roomData, roomUsers, selfInfo, w } from './helpers';

const CHAIR = 1001;
const RARE = 1005;
const POSTER = 4001;
const catalog: FurniCatalog = {
  [CHAIR]: { name: 'chair_plasto', xdim: 1, ydim: 1, sit: true, lay: false, offerId: 10 },
  [RARE]: { name: 'rare_dragonlamp', xdim: 1, ydim: 1, sit: false, lay: false, offerId: -1 },
};
const walls: WallCatalog = { [POSTER]: { name: 'poster', offerId: 900 } };

/** IN 1369 sintético. */
function wallItems(items: { id: string; spriteId: number; pos: string; state?: string; owner?: number }[], owners: Record<number, string> = { 1: 'Dono' }) {
  const wr = w().int32(Object.keys(owners).length);
  for (const [id, name] of Object.entries(owners)) wr.int32(parseInt(id, 10)).string(name);
  wr.int32(items.length);
  for (const it of items) wr.string(it.id).int32(it.spriteId).string(it.pos).string(it.state ?? '0').int32(-1).int32(0).int32(it.owner ?? 1);
  return wr;
}

/** IN 1301 sintético: planta 4x3 com uma área do Habblet no fim. */
function floorPlan(rows: string[], areas: { id: number; x: number; y: number; w: number; h: number }[] = []) {
  const wr = w().boolean(true).int32(-1).string(rows.join('\r') + '\r').int32(areas.length);
  for (const a of areas) wr.int32(a.id).boolean(true).int32(a.x).int32(a.y).int32(a.w).int32(a.h);
  return wr;
}

/** IN 2753 sintético. */
function heightMap(width: number, values: number[]) {
  const wr = w().int32(width).int32(values.length);
  for (const v of values) wr.int16(v);
  return wr;
}

describe('parsers de planta, pintura, mobis de parede, porta e casas ocupadas', () => {
  it('1369: mobis de parede com dono e posição', () => {
    const res = parseWallItems(new PacketReader(wallItems([{ id: '189221879', spriteId: POSTER, pos: ':w=0,25 l=2,37 l', state: '0', owner: 7 }], { 7: 'Fulano' }).bytes()));
    expect(res.partial).toBe(false);
    expect(res.items[0]).toEqual({ id: '189221879', spriteId: POSTER, wallPosition: ':w=0,25 l=2,37 l', state: '0', expires: -1, usagePolicy: 0, ownerId: 7, ownerName: 'Fulano' });
  });

  it('2454: pintura', () => {
    expect(parseRoomPaint(new PacketReader(w().string('floor').string('205').bytes()))).toEqual({ type: 'floor', value: '205' });
  });

  it('1301: planta com linhas, altura da parede e áreas do Habblet; sem áreas também', () => {
    const plan = parseFloorPlan(new PacketReader(floorPlan(['xxxx', 'x00x', 'x0ax'], [{ id: 42, x: 1, y: 1, w: 2, h: 2 }]).bytes()));
    expect(plan).toMatchObject({ zoomedIn: true, wallHeight: -1, rows: ['xxxx', 'x00x', 'x0ax'] });
    expect(plan.areas).toEqual([{ id: 42, flag: true, x: 1, y: 1, w: 2, h: 2 }]);
    expect(floorPlanHeight('x')).toBeNull();
    expect(floorPlanHeight('0')).toBe(0);
    expect(floorPlanHeight('a')).toBe(10);
    const bare = parseFloorPlan(new PacketReader(w().boolean(false).int32(3).string('x0\rx0').bytes()));
    expect(bare.rows).toEqual(['x0', 'x0']);
    expect(bare.areas).toEqual([]);
  });

  it('2753: altura do topo por casa, sem chão e bloqueio de empilhamento', () => {
    const hm = parseHeightMap(new PacketReader(heightMap(3, [0x3f3f, 0x0000, 0x0100, 0x4166, 0x0180, 0x3f3f]).bytes()));
    expect(hm).toMatchObject({ width: 3, height: 2 });
    expect(hm.heights).toEqual([null, 0, 1, 358 / 256, 1.5, null]);
    expect(hm.stackingBlocked).toEqual([false, false, false, true, false, false]);
  });

  it('1664 e 3990', () => {
    expect(parseRoomEntryTile(new PacketReader(w().int32(4).int32(7).int32(2).bytes()))).toEqual({ x: 4, y: 7, direction: 2 });
    expect(parseOccupiedTiles(new PacketReader(w().int32(2).int32(5).int32(1).int32(5).int32(2).bytes()))).toEqual([{ x: 5, y: 1 }, { x: 5, y: 2 }]);
  });
});

function enterRoom(state: GameState, roomId = 10) {
  state.handle(IN(H.USER_INFO, selfInfo(1, 'Eu')));
  state.handle(OUT(O.ROOM_ENTER, w().int32(roomId).string('')));
  state.handle(IN(H.ROOM_READY));
  state.handle(IN(H.ROOM_FLOOR_PLAN, floorPlan(['xxxx', 'x00x', 'x00x', 'xxxx'])));
  state.handle(IN(H.ROOM_PAINT, w().string('floor').string('205')));
  state.handle(IN(H.ROOM_PAINT, w().string('wallpaper').string('304')));
  state.handle(IN(H.ROOM_HEIGHT_MAP, heightMap(4, [0x3f3f, 0x3f3f, 0x3f3f, 0x3f3f, 0x3f3f, 0x0100, 0x0000, 0x3f3f, 0x3f3f, 0x0000, 0x0000, 0x3f3f, 0x3f3f, 0x3f3f, 0x3f3f, 0x3f3f])));
  state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 1, name: 'Eu', roomIndex: 1 }])));
  state.handle(IN(H.ROOM_DATA, roomData({ roomId, name: 'Meu  Quarto!', ownerName: 'Dono' })));
  state.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems([
    { id: 2, spriteId: RARE, x: 2, y: 2, z: 1, stackHeight: 0.5 },
    { id: 1, spriteId: CHAIR, x: 1, y: 1, direction: 2, state: '1' },
    { id: 3, spriteId: CHAIR, x: 2, y: 2 },
    { id: 4, spriteId: 999, x: 2, y: 1 },
  ])));
  state.handle(IN(H.ROOM_WALL_ITEMS, wallItems([{ id: '50', spriteId: POSTER, pos: ':w=0,2 l=1,3 l' }])));
}

describe('GameState × planta, pintura, paredes, porta', () => {
  it('guarda tudo no quarto e zera ao trocar de quarto; porta e casas ocupadas chegam a pedido', () => {
    const state = new GameState();
    const sends = captureSends();
    const actions = createGameActions(sends.send, state);
    enterRoom(state);
    let snap = state.snapshot();
    expect(snap.room.floorPlan?.rows).toEqual(['xxxx', 'x00x', 'x00x', 'xxxx']);
    expect(snap.room.paint).toEqual({ floor: '205', wallpaper: '304' });
    expect(snap.room.heightMap?.heights[5]).toBe(1);
    expect(snap.room.wallItems.map((i) => i.id)).toEqual(['50']);
    expect(snap.room.door).toBeNull();
    actions.requestRoomLayout();
    expect(sends.sent.map((p) => p.header)).toEqual([O.GET_ROOM_ENTRY_TILE, O.GET_OCCUPIED_TILES]);
    state.handle(IN(H.ROOM_ENTRY_TILE, w().int32(1).int32(2).int32(4)));
    state.handle(IN(H.ROOM_OCCUPIED_TILES, w().int32(1).int32(2).int32(2)));
    snap = state.snapshot();
    expect(snap.room.door).toEqual({ x: 1, y: 2, direction: 4 });
    expect(snap.room.occupiedTiles).toEqual([{ x: 2, y: 2 }]);
    enterRoom(state, 11);
    snap = state.snapshot();
    expect(snap.room.door).toBeNull();
    expect(snap.room.paint).toEqual({ floor: '205', wallpaper: '304' }); // repintado na entrada
  });
});

describe('buildRoomCopy', () => {
  it('monta o JSON com planta, porta, pintura, alturas, mobis nomeados e lista de compras', () => {
    const state = new GameState();
    enterRoom(state);
    state.handle(IN(H.ROOM_ENTRY_TILE, w().int32(1).int32(2).int32(4)));
    const copy = buildRoomCopy(state.snapshot(), catalog, walls, new Date('2026-09-21T01:30:00Z'));
    expect(copy.version).toBe(1);
    expect(copy.room).toEqual({ id: 10, name: 'Meu  Quarto!', ownerName: 'Dono' });
    expect(copy.floorPlan).toEqual({ rows: ['xxxx', 'x00x', 'x00x', 'xxxx'], wallHeight: -1, width: 4, height: 4, door: { x: 1, y: 2, direction: 4 } });
    expect(copy.paint).toEqual({ floor: '205', wallpaper: '304' });
    expect(copy.heights).toEqual([[null, null, null, null], [null, 1, 0, null], [null, 0, 0, null], [null, null, null, null]]);
    // ordem: por altura (z), depois y, x — o raro (z 1) vem por último
    expect(copy.floorItems.map((i) => i.id)).toEqual([1, 4, 3, 2]);
    expect(copy.floorItems[0]).toMatchObject({ type: CHAIR, name: 'chair_plasto', x: 1, y: 1, direction: 2, z: 0, stackHeight: 1, state: '1', offerId: 10 });
    expect(copy.floorItems.find((i) => i.id === 4)).toMatchObject({ type: 999, name: null, offerId: null });
    expect(copy.wallItems).toEqual([{ id: '50', type: POSTER, name: 'poster', position: ':w=0,2 l=1,3 l', state: '0', offerId: 900 }]);
    expect(copy.shopping).toEqual([
      { type: CHAIR, name: 'chair_plasto', kind: 'floor', count: 2, offerId: 10 },
      { type: 999, name: null, kind: 'floor', count: 1, offerId: null },
      { type: POSTER, name: 'poster', kind: 'wall', count: 1, offerId: 900 },
      { type: RARE, name: 'rare_dragonlamp', kind: 'floor', count: 1, offerId: -1 },
    ]);
    expect(copy.summary).toEqual({ floorItems: 4, wallItems: 1, purchasable: 3, notPurchasable: 2, types: 4, hasFloorPlan: true, hasDoor: true, hasWallItems: true });
    expect(roomCopyFileName(copy)).toBe('quarto-10-Meu-Quarto-2026-09-21-01-30-00.json');
    expect(describeRoomCopy(copy)).toBe('4 mobi(s) de chão · 1 de parede · 2 sem oferta no catálogo');
  });

  it('sem catálogo e sem porta: nomes null, avisa no resumo', () => {
    const state = new GameState();
    enterRoom(state);
    const copy = buildRoomCopy(state.snapshot(), null, null);
    expect(copy.floorItems.every((i) => i.name === null && i.offerId === null)).toBe(true);
    expect(copy.summary.purchasable).toBe(0);
    expect(copy.floorPlan?.door).toBeNull();
    expect(describeRoomCopy(copy)).toContain('sem porta');
  });
});
