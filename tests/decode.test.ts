import { describe, expect, it } from 'vitest';
import { PacketReader, PacketWriter, assembleBody, base64ToBytes, bytesToBase64, bytesToHex, extractStrings, hexDump, hexToBytes } from '../src/protocol/decode';

describe('PacketWriter / PacketReader', () => {
  it('faz o round-trip dos primitivos em big-endian', () => {
    const bytes = new PacketWriter().int32(-2).int16(300).byte(7).boolean(true).string('olá').bytes();
    expect(bytesToHex(bytes)).toBe('ff ff ff fe 01 2c 07 01 00 04 6f 6c c3 a1');
    const r = new PacketReader(bytes);
    expect(r.int32()).toBe(-2);
    expect(r.int16()).toBe(300);
    expect(r.byte()).toBe(7);
    expect(r.boolean()).toBe(true);
    expect(r.string()).toBe('olá');
    expect(r.remaining).toBe(0);
  });

  it('lança RangeError quando uma string não cabe no corpo (pacote truncado)', () => {
    const full = new PacketWriter().string('Dominguez').bytes();
    const cut = full.subarray(0, full.length - 3);
    expect(() => new PacketReader(cut).string()).toThrow(RangeError);
  });

  it('lança RangeError ao ler int32 além do fim', () => {
    expect(() => new PacketReader(new Uint8Array(2)).int32()).toThrow(RangeError);
  });
});

describe('base64 / hex', () => {
  it('round-trip base64 com corpos grandes (acima de 32 KB, limite do fromCharCode)', () => {
    const big = new Uint8Array(70000).map((_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  it('base64 inválido vira corpo vazio em vez de exceção', () => {
    expect(base64ToBytes('%%%').length).toBe(0);
  });

  it('hexToBytes aceita espaços e rejeita número ímpar de dígitos', () => {
    expect(hexToBytes('0a ff\n10')).toEqual(new Uint8Array([0x0a, 0xff, 0x10]));
    expect(() => hexToBytes('abc')).toThrow();
  });

  it('hexDump agrupa em linhas de 16 bytes com ASCII', () => {
    const lines = hexDump(new Uint8Array([...'Habblet!'].map((c) => c.charCodeAt(0)).concat([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])));
    expect(lines).toHaveLength(2);
    expect(lines[0].offset).toBe('000000');
    expect(lines[0].ascii).toBe('Habblet!........');
    expect(lines[1].ascii).toBe('..');
  });
});

describe('extractStrings', () => {
  it('encontra strings no formato int16 + UTF-8 e pula falsos positivos', () => {
    const body = new PacketWriter().int32(5909416).string('DATAPOL').int32(0).string('Wzzer').bytes();
    const found = extractStrings(body).map((s) => s.value);
    expect(found).toContain('DATAPOL');
    expect(found).toContain('Wzzer');
  });
});

describe('assembleBody (mini-linguagem da aba Protocolo)', () => {
  it('monta int32, int16, byte, string e hex na ordem das linhas', () => {
    const body = assembleBody(['# comentário', 'i 1', 's 2', 'b true', 't oi', 'x 0a0b'].join('\n'));
    expect(bytesToHex(body)).toBe('00 00 00 01 00 02 01 00 02 6f 69 0a 0b');
  });

  it('rejeita linha desconhecida', () => {
    expect(() => assembleBody('z 1')).toThrow(/Linha inválida/);
  });
});
