import { describe, expect, it } from 'vitest';
import { PacketReader } from '../src/protocol/decode';
import { parseFloorItem, parseFloorItemAdd, parseFloorItemRemove, parseFloorItems } from '../src/protocol/nitro/parsers';
import { IN as H, OUT as O } from '../src/protocol/nitro/headers';
import { GameState } from '../src/protocol/state/GameState';
import { compactFurnidata, furniFootprint } from '../shared/furnidata';
import type { FurniCatalog } from '../shared/furnidata';
import { postureSpots } from '../src/addons/protocol/postureEngine';
import { IN, OUT, floorItemAdd, floorItemRemove, floorItems, roomData, roomUsers, selfInfo, w, writeFloorItem } from './helpers';

const CHAIR = 1001;
const SOFA = 1002;
const BED = 1003;
const TABLE = 1004;
const catalog: FurniCatalog = {
  [CHAIR]: { name: 'chair_plasto', xdim: 1, ydim: 1, sit: true, lay: false, offerId: 10 },
  [SOFA]: { name: 'sofa*2', xdim: 2, ydim: 1, sit: true, lay: false, offerId: 11 },
  [BED]: { name: 'bed_budget', xdim: 2, ydim: 3, sit: false, lay: true, offerId: -1 },
};

describe('parsers de mobis de chão (1778 / 1534 / 3776 / 2703)', () => {
  it('lê a lista com donos, estado legado e edição limitada', () => {
    const body = floorItems(
      [
        { id: 10, spriteId: CHAIR, x: 3, y: 4, direction: 2, z: 0.5, stackHeight: 1, ownerId: 7, state: '1' },
        { id: 11, spriteId: SOFA, x: 5, y: 5, unique: { number: 39, series: 75 } },
      ],
      { 7: 'Fulano' },
    ).bytes();
    const res = parseFloorItems(new PacketReader(body));
    expect(res.partial).toBe(false);
    expect(res.declaredCount).toBe(2);
    expect(res.items[0]).toMatchObject({ id: 10, spriteId: CHAIR, x: 3, y: 4, direction: 2, z: 0.5, stackHeight: 1, ownerId: 7, ownerName: 'Fulano', state: '1', dataKind: 0 });
    expect(res.items[1]).toMatchObject({ id: 11, spriteId: SOFA, x: 5, y: 5 });
    expect(res.items[1].ownerName).toBeUndefined();
  });

  it('lê os outros tipos de dados sem perder o alinhamento (mapa, strings, números, placar do Habblet, quebrável)', () => {
    const wr = w().int32(0).int32(5);
    const head = (id: number) => wr.int32(id).int32(500).int32(1).int32(1).int32(0).string('0.0').string('1.0').int32(0);
    const tail = () => wr.int32(-1).int32(0).int32(9);
    head(1).int32(1).int32(2).string('state').string('2').string('MESSAGE').string('oi'); tail(); // mapa
    head(2).int32(2).int32(3).string('0').string('HBT1398').string('Lay30'); tail(); // strings
    head(3).int32(5).int32(2).int32(7).int32(8); tail(); // números
    head(4).int32(6).string('1').string('MAIOR TEMPO').int32(999).string('Usuário(s)').string('Duração').int32(1).int32(0).int32(2)
      .int32(0).int32(34).int32(1).string('Chanel,')
      .int32(0).int32(36).int32(2).string('Wooski').string('Zé'); tail(); // placar (variante Habblet)
    head(5).int32(7).string('3').int32(12).int32(20); tail(); // quebrável
    const res = parseFloorItems(new PacketReader(wr.bytes()));
    expect(res.partial).toBe(false);
    expect(res.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(res.items.map((i) => i.state)).toEqual(['2', '0', '7', '1', '3']);
    expect(res.items.map((i) => i.dataKind)).toEqual([1, 2, 5, 6, 7]);
  });

  it('classe estática quando spriteId é negativo', () => {
    const wr = w().int32(77).int32(-5).int32(1).int32(2).int32(0).string('0').string('0').int32(0).int32(0).string('').int32(-1).int32(0).int32(0).string('static_class');
    const it = parseFloorItem(new PacketReader(wr.bytes()));
    expect(it.spriteId).toBe(-5);
    expect(it.staticClass).toBe('static_class');
  });

  it('corpo truncado: fica com os mobis que couberam e marca partial', () => {
    const full = floorItems([{ id: 1, spriteId: CHAIR, x: 0, y: 0 }, { id: 2, spriteId: CHAIR, x: 1, y: 0 }, { id: 3, spriteId: CHAIR, x: 2, y: 0 }]).bytes();
    const res = parseFloorItems(new PacketReader(full.subarray(0, full.length - 10)));
    expect(res.partial).toBe(true);
    expect(res.declaredCount).toBe(3);
    expect(res.items.map((i) => i.id)).toEqual([1, 2]);
  });

  it('1534 traz o nome do dono no fim; 2703 traz o id como string', () => {
    const add = parseFloorItemAdd(new PacketReader(floorItemAdd({ id: 55, spriteId: CHAIR, x: 1, y: 2 }, 'CoditriPaz').bytes()));
    expect(add).toMatchObject({ id: 55, ownerName: 'CoditriPaz' });
    expect(parseFloorItemRemove(new PacketReader(floorItemRemove(247782448).bytes()))).toEqual({ id: 247782448, expired: false, pickerId: 0, delay: 0 });
  });
});

describe('furnidata', () => {
  it('compacta todos os mobis (nome, tamanho, sentável, oferta) e os de parede', () => {
    const raw = {
      roomitemtypes: { furnitype: [
        { id: 1, classname: 'chair', xdim: 1, ydim: 1, cansiton: true, canlayon: false, canstandon: false, offerid: 501 },
        { id: 2, classname: 'table', xdim: 2, ydim: 2, cansiton: false, canlayon: false, canstandon: true, offerid: -1 },
        { id: 3, classname: 'bed', xdim: 2, ydim: 3, cansiton: false, canlayon: true },
        { id: 4, classname: 'weird', xdim: 0, ydim: 0, cansiton: true, offerid: 7 },
        { classname: 'sem id', cansiton: true },
      ] },
      wallitemtypes: { furnitype: [{ id: 9, classname: 'poster', offerid: 900 }, { id: 10, classname: 'rare_poster', offerid: -1 }] },
    };
    const { total, items, walls } = compactFurnidata(raw);
    expect(total).toBe(4);
    expect(Object.keys(items).map(Number).sort()).toEqual([1, 2, 3, 4]);
    expect(items[1]).toEqual({ name: 'chair', xdim: 1, ydim: 1, sit: true, lay: false, offerId: 501 });
    expect(items[3]).toEqual({ name: 'bed', xdim: 2, ydim: 3, sit: false, lay: true, offerId: -1 }); // sem offerid = -1
    expect(items[4]).toMatchObject({ xdim: 1, ydim: 1 }); // 0x0 vira 1x1
    expect(walls).toEqual({ 9: { name: 'poster', offerId: 900 }, 10: { name: 'rare_poster', offerId: -1 } });
    expect(compactFurnidata(null)).toEqual({ total: 0, items: {}, walls: {} });
  });

  it('furniFootprint gira o mobi nas direções 2 e 6', () => {
    const info = { xdim: 2, ydim: 3 };
    expect(furniFootprint({ x: 5, y: 5, direction: 0 }, info)).toHaveLength(6);
    expect(furniFootprint({ x: 5, y: 5, direction: 0 }, info)).toContainEqual({ x: 6, y: 7 });
    expect(furniFootprint({ x: 5, y: 5, direction: 2 }, info)).toContainEqual({ x: 7, y: 6 });
    expect(furniFootprint({ x: 5, y: 5, direction: 2 }, info)).not.toContainEqual({ x: 6, y: 7 });
    expect(furniFootprint({ x: 1, y: 1, direction: 4 }, undefined)).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('postureSpots', () => {
  const item = (id: number, spriteId: number, x: number, y: number, direction = 0, z = 0, stackHeight = 1) => ({ id, spriteId, x, y, direction, z, stackHeight, extra: 0, dataKind: 0, state: '0', expires: -1, usagePolicy: 0, ownerId: 1 });

  it('casa da cadeira, as duas do sofá girado, e a cama só para deitar', () => {
    const items = [item(1, CHAIR, 2, 2), item(2, SOFA, 5, 5, 2), item(3, BED, 8, 8)];
    const sit = postureSpots(items, catalog, 'sit');
    expect([...sit.keys()].sort()).toEqual(['2,2', '5,5', '5,6']);
    expect(sit.get('5,6')?.name).toBe('sofa');
    const lay = postureSpots(items, catalog, 'lay');
    expect(lay.size).toBe(6);
    expect(lay.has('8,8')).toBe(true);
    expect(lay.has('2,2')).toBe(false);
  });

  it('um mobi mais alto em cima da cadeira anula a casa; mobi fora do catálogo não conta', () => {
    const items = [item(1, CHAIR, 2, 2, 0, 0, 1), item(2, TABLE, 2, 2, 0, 1, 0.5), item(3, 999999, 4, 4)];
    const sit = postureSpots(items, catalog, 'sit');
    expect(sit.size).toBe(0);
    expect(postureSpots([item(1, CHAIR, 2, 2)], null, 'sit').size).toBe(0);
  });
});

describe('GameState × mobis', () => {
  function enter(state: GameState, roomId = 10) {
    state.handle(IN(H.USER_INFO, selfInfo(1, 'Eu')));
    state.handle(OUT(O.ROOM_ENTER, w().int32(roomId).string('')));
    state.handle(IN(H.ROOM_READY));
    state.handle(IN(H.ROOM_USERS, roomUsers([{ id: 1, name: 'Eu', roomIndex: 1 }])));
    state.handle(IN(H.ROOM_DATA, roomData({ roomId, name: 'Sala' })));
  }

  it('1778 preenche, 1534 acrescenta, 3776 move, 2703 remove; a lista só muda quando um mobi muda', () => {
    const state = new GameState();
    enter(state);
    state.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }, { id: 2, spriteId: SOFA, x: 3, y: 3 }])));
    const list1 = state.snapshot().room.floorItems;
    expect(list1.map((i) => i.id)).toEqual([1, 2]);
    expect(state.floorItemCount).toBe(2);
    state.handle(IN(H.UNIT_TYPING, w().int32(1).int32(1))); // bump sem mexer em mobi
    expect(state.snapshot().room.floorItems).toBe(list1);
    state.handle(IN(H.ROOM_FLOOR_ITEM_ADD, floorItemAdd({ id: 3, spriteId: CHAIR, x: 6, y: 6 }, 'Dono')));
    expect(state.snapshot().room.floorItems.map((i) => i.id)).toEqual([1, 2, 3]);
    state.handle(IN(H.ROOM_FLOOR_ITEM_UPDATE, writeFloorItem(w(), { id: 1, spriteId: CHAIR, x: 9, y: 9 })));
    expect(state.snapshot().room.floorItems.find((i) => i.id === 1)).toMatchObject({ x: 9, y: 9, ownerName: 'Dono' });
    state.handle(IN(H.ROOM_FLOOR_ITEM_REMOVE, floorItemRemove(2)));
    expect(state.snapshot().room.floorItems.map((i) => i.id)).toEqual([1, 3]);
  });

  it('trocar de quarto limpa os mobis; lista truncada vira decode-error mas mantém o que coube', () => {
    const state = new GameState();
    enter(state);
    state.handle(IN(H.ROOM_FLOOR_ITEMS, floorItems([{ id: 1, spriteId: CHAIR, x: 1, y: 1 }])));
    expect(state.floorItemCount).toBe(1);
    enter(state, 11);
    expect(state.floorItemCount).toBe(0);
    const full = floorItems([{ id: 5, spriteId: CHAIR, x: 0, y: 0 }, { id: 6, spriteId: CHAIR, x: 1, y: 0 }]).bytes();
    state.handle(IN(H.ROOM_FLOOR_ITEMS, full.subarray(0, full.length - 6)));
    expect(state.floorItemCount).toBe(1);
    expect(state.snapshot().events.at(-1)).toMatchObject({ kind: 'decode-error', header: H.ROOM_FLOOR_ITEMS });
  });
});
