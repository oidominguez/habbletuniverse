/**
 * Utilidades de decodificação para a aba Protocolo.
 *
 * O protocolo Habbo/Nitro serializa primitivos em big-endian:
 *   int32, int16, byte/boolean e string = int16 tamanho + bytes UTF-8.
 * Sem saber a estrutura de cada header, o melhor que dá para fazer automaticamente é
 * um hex dump e uma busca heurística por strings, que costumam revelar nomes de
 * usuário, textos de chat, nomes de quarto etc.
 */

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  } catch {
    return new Uint8Array(0);
  }
}

export function bytesToBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function bytesToHex(u8: Uint8Array, sep = ' '): string {
  const parts: string[] = [];
  for (let i = 0; i < u8.length; i++) parts.push(u8[i].toString(16).padStart(2, '0'));
  return parts.join(sep);
}

/** "0a 1b ff" ou "0a1bff" → bytes. Ignora espaços e quebras; lança em dígito inválido. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Hex com número ímpar de dígitos');
  const u8 = new Uint8Array(clean.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(clean.substr(i * 2, 2), 16);
  return u8;
}

export interface HexDumpLine {
  offset: string;
  hex: string;
  ascii: string;
}

export function hexDump(u8: Uint8Array, width = 16, maxLines = 256): HexDumpLine[] {
  const lines: HexDumpLine[] = [];
  for (let off = 0; off < u8.length && lines.length < maxLines; off += width) {
    const chunk = u8.subarray(off, off + width);
    const hexParts: string[] = [];
    let ascii = '';
    for (let i = 0; i < width; i++) {
      if (i < chunk.length) {
        hexParts.push(chunk[i].toString(16).padStart(2, '0'));
        ascii += chunk[i] >= 0x20 && chunk[i] < 0x7f ? String.fromCharCode(chunk[i]) : '.';
      } else {
        hexParts.push('  ');
      }
      if (i === 7) hexParts.push('');
    }
    lines.push({ offset: off.toString(16).padStart(6, '0'), hex: hexParts.join(' '), ascii });
  }
  return lines;
}

export interface FoundString {
  offset: number;
  length: number;
  value: string;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function isReadable(s: string): boolean {
  if (!s.length) return false;
  let printable = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) {
      printable++;
      continue;
    }
    if (c < 0x20 || c === 0x7f) return false;
    printable++;
  }
  return printable === [...s].length;
}

/**
 * Procura strings no formato Nitro (`int16 tamanho` + UTF-8) varrendo cada offset.
 * Quando encontra uma válida, pula para depois dela para reduzir falsos positivos.
 */
export function extractStrings(u8: Uint8Array, maxLen = 512, minLen = 1): FoundString[] {
  const out: FoundString[] = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 0;
  while (i + 2 <= u8.length) {
    const len = dv.getInt16(i);
    if (len >= minLen && len <= maxLen && i + 2 + len <= u8.length) {
      try {
        const value = utf8Decoder.decode(u8.subarray(i + 2, i + 2 + len));
        if (isReadable(value)) {
          out.push({ offset: i, length: len, value });
          i += 2 + len;
          continue;
        }
      } catch {
        /* não é UTF-8 válido */
      }
    }
    i++;
  }
  return out;
}

/** Leitura sequencial de primitivos (para inspeção manual passo a passo). */
export class PacketReader {
  private pos = 0;
  private readonly dv: DataView;
  constructor(private readonly u8: Uint8Array) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  get offset(): number {
    return this.pos;
  }
  get remaining(): number {
    return this.u8.length - this.pos;
  }
  int32(): number {
    const v = this.dv.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  int16(): number {
    const v = this.dv.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  byte(): number {
    return this.u8[this.pos++];
  }
  boolean(): boolean {
    return this.byte() !== 0;
  }
  string(): string {
    const len = this.int16();
    // `subarray` não reclama de ler além do fim; sem esta checagem uma string cortada (pacote truncado)
    // voltaria pela metade e o decodificador seguiria lendo lixo.
    if (len < 0 || len > this.remaining) throw new RangeError(`String de ${len} bytes não cabe nos ${this.remaining} restantes`);
    const v = utf8Decoder.decode(this.u8.subarray(this.pos, this.pos + len));
    this.pos += len;
    return v;
  }
}

/** Escrita sequencial para montar pacotes manualmente. */
export class PacketWriter {
  private chunks: Uint8Array[] = [];
  int32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v);
    this.chunks.push(b);
    return this;
  }
  int16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v);
    this.chunks.push(b);
    return this;
  }
  byte(v: number): this {
    this.chunks.push(new Uint8Array([v & 0xff]));
    return this;
  }
  boolean(v: boolean): this {
    return this.byte(v ? 1 : 0);
  }
  string(s: string): this {
    const bytes = new TextEncoder().encode(s);
    this.int16(bytes.length);
    this.chunks.push(bytes);
    return this;
  }
  raw(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }
  bytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/**
 * Mini-linguagem para montar corpo de pacote na aba Protocolo, um campo por linha:
 *   i 123      → int32
 *   s 45       → int16 (short)
 *   b 1        → byte / boolean
 *   t Fulano   → string (int16 tamanho + UTF-8)
 *   x 0a ff    → bytes crus em hex
 */
export function assembleBody(spec: string): Uint8Array {
  const wr = new PacketWriter();
  for (const rawLine of spec.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([isbtx])\s*(.*)$/i);
    if (!m) throw new Error(`Linha inválida: "${line}"`);
    const kind = m[1].toLowerCase();
    const arg = m[2];
    if (kind === 'i') wr.int32(parseInt(arg, 10) | 0);
    else if (kind === 's') wr.int16(parseInt(arg, 10) | 0);
    else if (kind === 'b') wr.byte(/^(true|1)$/i.test(arg) ? 1 : parseInt(arg, 10) | 0);
    else if (kind === 't') wr.string(arg);
    else if (kind === 'x') wr.raw(hexToBytes(arg));
  }
  return wr.bytes();
}
