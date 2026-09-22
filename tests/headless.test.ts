import { describe, expect, it } from 'vitest';
import { H, NitroClientEmulation, POST_AUTH_BURST, POST_USER_INFO_BURST, framePacket, int32, parseFrames, str } from '../electron/headless-protocol';

describe('framing em Buffer', () => {
  it('framePacket e parseFrames fazem o round-trip, inclusive com vários pacotes num frame', () => {
    const a = framePacket(2312, Buffer.concat([int32(7078217), str('')]));
    const b = framePacket(3928, Buffer.alloc(0));
    const { packets, rest } = parseFrames(Buffer.concat([a, b]));
    expect(packets.map((p) => p.header)).toEqual([2312, 3928]);
    expect(packets[0].body.readInt32BE(0)).toBe(7078217);
    expect(rest.length).toBe(0);
  });

  it('guarda o resto quando o frame vem cortado', () => {
    const a = framePacket(374, Buffer.alloc(100, 1));
    const { packets, rest } = parseFrames(a.subarray(0, 50));
    expect(packets).toEqual([]);
    expect(rest.length).toBe(50);
    const again = parseFrames(Buffer.concat([rest, a.subarray(50)]));
    expect(again.packets.map((p) => p.header)).toEqual([374]);
  });

  it('str escreve int16 tamanho + UTF-8', () => {
    expect([...str('oi')]).toEqual([0, 2, 0x6f, 0x69]);
  });
});

describe('emulação do cliente Nitro', () => {
  it('responde ping com pong', () => {
    const e = new NitroClientEmulation();
    expect(e.onIncoming(H.PING, Buffer.alloc(0))).toEqual([{ header: H.PONG, body: Buffer.alloc(0) }]);
  });

  it('manda a rajada pós-login no 2491 e a do 2725', () => {
    const e = new NitroClientEmulation();
    expect(e.onIncoming(H.AUTH_OK, Buffer.alloc(0)).map((p) => p.header)).toEqual([...POST_AUTH_BURST]);
    expect(e.onIncoming(H.USER_INFO, Buffer.alloc(0)).map((p) => p.header)).toEqual([...POST_USER_INFO_BURST]);
  });

  it('entrada em quarto: 758 → 21, 2300; primeiro 374 → 351 e 2230 (roomId, 1, 0)', () => {
    const e = new NitroClientEmulation();
    e.noteOutgoing(H.ROOM_ENTER, Buffer.concat([int32(6539664), str('')]));
    expect(e.onIncoming(H.ROOM_READY, Buffer.alloc(0)).map((p) => p.header)).toEqual([21, 2300]);
    const after = e.onIncoming(H.ROOM_USERS, Buffer.alloc(0));
    expect(after.map((p) => p.header)).toEqual([351, H.GET_GUEST_ROOM]);
    const body = after[1].body;
    expect([body.readInt32BE(0), body.readInt32BE(4), body.readInt32BE(8)]).toEqual([6539664, 1, 0]);
    // 374 seguintes (chegadas) não repetem a sequência
    expect(e.onIncoming(H.ROOM_USERS, Buffer.alloc(0))).toEqual([]);
  });

  it('encaminhamento (160) vira 2312 direto e passa a ser o quarto pendente', () => {
    const e = new NitroClientEmulation();
    const out = e.onIncoming(H.ROOM_FORWARD, int32(7092591));
    expect(out).toHaveLength(1);
    expect(out[0].header).toBe(H.ROOM_ENTER);
    expect(out[0].body.readInt32BE(0)).toBe(7092591);
    expect(e.currentRoomId).toBe(7092591);
  });

  it('ignora o que não emula', () => {
    const e = new NitroClientEmulation();
    expect(e.onIncoming(1446, Buffer.alloc(8))).toEqual([]);
  });
});
