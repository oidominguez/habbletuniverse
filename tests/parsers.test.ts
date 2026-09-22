import { describe, expect, it } from 'vitest';
import { PacketReader } from '../src/protocol/decode';
import {
  parseChat,
  parseFriendRequest,
  parseFriendsFragment,
  parseFriendsUpdate,
  parseGuestRoomResult,
  parseNavigatorResults,
  parseRoomEnterError,
  parseRoomUsers,
  parseSelfInfo,
  parseUnitActions,
  parseUnitStatuses,
} from '../src/protocol/nitro/parsers';
import * as composers from '../src/protocol/nitro/composers';
import { OUT } from '../src/protocol/nitro/headers';
import { chat, friendRequest, friendsList, friendsUpdate, navigatorResults, roomData, roomEnterError, roomUsers, selfInfo, unitStatuses, w } from './helpers';

const read = (wr: { bytes(): Uint8Array }) => new PacketReader(wr.bytes());

describe('usuário e amigos', () => {
  it('2725 devolve id, nome e missão', () => {
    const me = parseSelfInfo(read(selfInfo(5909416, 'DATAPOL', 'oi')));
    expect(me).toMatchObject({ id: 5909416, name: 'DATAPOL', motto: 'oi' });
  });

  it('3130 lê todos os amigos de um fragmento completo', () => {
    const frag = parseFriendsFragment(read(friendsList([{ id: 1, name: 'a' }, { id: 2, name: 'b', online: false }], 1, 3)));
    expect(frag).toMatchObject({ totalFragments: 3, fragment: 1, declaredCount: 2, partial: false });
    expect(frag.friends.map((f) => [f.id, f.name, f.online])).toEqual([[1, 'a', true], [2, 'b', false]]);
  });

  it('3130 truncado fica com os amigos que couberam e marca partial', () => {
    const full = friendsList([{ id: 1, name: 'primeiro' }, { id: 2, name: 'segundo' }, { id: 3, name: 'terceiro' }]).bytes();
    const cut = full.subarray(0, full.length - 10); // corta dentro do terceiro
    const frag = parseFriendsFragment(new PacketReader(cut));
    expect(frag.partial).toBe(true);
    expect(frag.declaredCount).toBe(3);
    expect(frag.friends.map((f) => f.name)).toEqual(['primeiro', 'segundo']);
  });

  it('2800 separa upserts (tipo 0 neste hotel) de remoções (-1)', () => {
    const upd = parseFriendsUpdate(read(friendsUpdate([{ id: 10, name: 'novo' }], [99])));
    expect(upd.upserted.map((f) => f.id)).toEqual([10]);
    expect(upd.removedIds).toEqual([99]);
    expect(upd.added).toEqual([]); // tipo 0 conta como "updated"
  });

  it('2219 devolve o id de quem pediu (usado pelo 137)', () => {
    expect(parseFriendRequest(read(friendRequest(5904602, 'kehlaree')))).toMatchObject({ requestId: 5904602, name: 'kehlaree' });
  });
});

describe('sala', () => {
  it('374 lê usuários e pets com os campos extras de cada tipo', () => {
    const users = parseRoomUsers(read(roomUsers([
      { id: 1, name: 'eu', roomIndex: 3, x: 5, y: 6 },
      { id: 77, name: 'Rex', roomIndex: 4, type: 2 },
      { id: 2, name: 'outro', roomIndex: 5 },
    ])));
    expect(users.map((u) => [u.name, u.roomIndex, u.type])).toEqual([['eu', 3, 1], ['Rex', 4, 2], ['outro', 5, 1]]);
    expect(users[0]).toMatchObject({ x: 5, y: 6, sex: 'M' });
  });

  it('1640 lê posição e a string de ações', () => {
    const st = parseUnitStatuses(read(unitStatuses([{ roomIndex: 3, x: 7, y: 10, actions: '/flatctrl 4/mv 7,10,0.0//' }])));
    expect(st[0]).toMatchObject({ roomIndex: 3, x: 7, y: 10, actions: '/flatctrl 4/mv 7,10,0.0//' });
  });

  it('gramática do campo actions: direitos, movimento, postura e outros', () => {
    expect(parseUnitActions('/flatctrl 4/mv 7,10,0.0//')).toMatchObject({ rights: 4, moveTarget: { x: 7, y: 10, z: 0 }, posture: null });
    expect(parseUnitActions('/sit 0.5//')).toMatchObject({ rights: null, moveTarget: null, posture: 'sit' });
    expect(parseUnitActions('/flatctrl 0/wav/sign 3//')).toMatchObject({ rights: 0, actions: ['wav', 'sign 3'] });
  });

  it('1446 lê a fala e tolera corpo sem a cauda de links/trackingId', () => {
    expect(parseChat(read(chat(12, 'oi'))).message).toBe('oi');
    const short = w().int32(12).string('curto').int32(0).int32(0);
    expect(parseChat(read(short))).toMatchObject({ roomIndex: 12, message: 'curto', links: [], trackingId: 0 });
  });

  it('899 lê motivo com e sem parâmetro', () => {
    expect(parseRoomEnterError(read(roomEnterError(1)))).toEqual({ reason: 1, parameter: '' });
    expect(parseRoomEnterError(new PacketReader(w().int32(4).bytes()))).toEqual({ reason: 4, parameter: '' });
  });

  it('687 e 2690 compartilham o RoomData', () => {
    const res = parseGuestRoomResult(read(roomData({ roomId: 7078217, name: 'Sala', userCount: 12, doorMode: 1 })));
    expect(res.room).toMatchObject({ roomId: 7078217, name: 'Sala', userCount: 12, doorMode: 1 });
    const nav = parseNavigatorResults(read(navigatorResults([{ roomId: 1, name: 'A', userCount: 3 }, { roomId: 2, name: 'B', userCount: 9 }])));
    expect(nav.blocks[0].rooms.map((r) => r.roomId)).toEqual([1, 2]);
  });
});

describe('compositores', () => {
  it('3157 é só a string do nome', () => {
    const p = composers.requestFriend('Wzzer');
    expect(p.header).toBe(OUT.REQUEST_FRIEND);
    expect(new PacketReader(p.body).string()).toBe('Wzzer');
  });

  it('137 leva contagem e ids', () => {
    const r = new PacketReader(composers.acceptFriends([5, 6]).body);
    expect([r.int32(), r.int32(), r.int32()]).toEqual([2, 5, 6]);
  });

  it('1543 embute o destinatário na string', () => {
    const r = new PacketReader(composers.whisper('Fulano', 'oi').body);
    expect(r.string()).toBe('Fulano oi');
    expect(r.int32()).toBe(0);
  });

  it('998 grupo, 3582 nota e 2249 perfil por nick levam um campo cada; 2730 é gênero e depois o visual', () => {
    expect(new PacketReader(composers.joinGroup(4242).body).int32()).toBe(4242);
    expect(composers.joinGroup(1).header).toBe(OUT.GROUP_REQUEST);
    expect(new PacketReader(composers.rateRoom().body).int32()).toBe(1);
    expect(new PacketReader(composers.profileByName('Dominguez').body).string()).toBe('Dominguez');
    const r = new PacketReader(composers.setFigure('M', 'hd-180-1.hr-828-61').body);
    expect(r.string()).toBe('M');
    expect(r.string()).toBe('hd-180-1.hr-828-61');
    expect(composers.setFigure('F', 'x').header).toBe(OUT.USER_FIGURE);
  });

  it('1276 (convidar para o quarto) leva a contagem, os ids e a mensagem', () => {
    const p = composers.roomInvite([5, 6, 7], 'vem!');
    expect(p.header).toBe(OUT.SEND_ROOM_INVITE);
    const r = new PacketReader(p.body);
    expect([r.int32(), r.int32(), r.int32(), r.int32()]).toEqual([3, 5, 6, 7]);
    expect(r.string()).toBe('vem!');
  });

  it('2694 (respeitar) leva só o id do usuário', () => {
    const p = composers.respectUser(972491);
    expect(p.header).toBe(OUT.RESPECT_USER);
    expect(new PacketReader(p.body).int32()).toBe(972491);
  });

  it('2230 "visitar" é (roomId, 0, 1)', () => {
    const r = new PacketReader(composers.getGuestRoom(42, 0, 1).body);
    expect([r.int32(), r.int32(), r.int32()]).toEqual([42, 0, 1]);
  });
});
