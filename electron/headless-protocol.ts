/**
 * Parte pura do cliente sem tela: framing dos pacotes em Buffer e a emulação do que o cliente Nitro
 * manda sozinho em resposta ao servidor. Sem `electron`, sem `ws`: testável em Node puro.
 *
 * Tudo aqui foi copiado de capturas reais (docs/PROTOCOLO.md, seção "Conexão e login" e
 * "Entrar / trocar de quarto", capturas de 16 e 17/09/2026).
 */

export const H = {
  PING: 3928,
  PONG: 2596,
  /** Vazio, logo após o 2419: o servidor aceitou o ticket. */
  AUTH_OK: 2491,
  USER_INFO: 2725,
  ROOM_READY: 758,
  ROOM_USERS: 374,
  ROOM_FORWARD: 160,
  ROOM_ENTER: 2312,
  GET_GUEST_ROOM: 2230,
} as const;

/** Depois do 2491 o cliente pede tudo de uma vez: info, moedas, assinatura, amigos, badges, configurações… */
export const POST_AUTH_BURST: readonly number[] = [357, 219, 2781, 273, 3333, 813, 796, 2487, 487, 869, 1827];
/** Depois do 2725 (dados do próprio usuário). */
export const POST_USER_INFO_BURST: readonly number[] = [3027, 1782, 2448];
/** Logo após o 758 (quarto pronto): modelo e dados de entrada. */
export const ROOM_READY_BURST: readonly number[] = [21, 2300];
/** Depois do primeiro 374 do quarto o cliente manda 351 e o 2230 (roomId, 1, 0). */
export const ROOM_USERS_FOLLOWUP: readonly number[] = [351];

export interface RawPacket {
  header: number;
  body: Buffer;
}

/** Monta o frame: int32 tamanho (header + corpo), int16 header, corpo. */
export function framePacket(header: number, body: Uint8Array): Buffer {
  const out = Buffer.alloc(6 + body.length);
  out.writeInt32BE(2 + body.length, 0);
  out.writeInt16BE(header, 4);
  out.set(body, 6);
  return out;
}

/** Separa os pacotes concatenados num buffer. `rest` = bytes finais que não fecham um frame (guardar para o próximo). */
export function parseFrames(buf: Buffer): { packets: RawPacket[]; rest: Buffer } {
  const packets: RawPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readInt32BE(off);
    if (len < 2) {
      // lixo: descarta tudo para não travar
      return { packets, rest: Buffer.alloc(0) };
    }
    if (off + 4 + len > buf.length) break;
    packets.push({ header: buf.readInt16BE(off + 4), body: buf.subarray(off + 6, off + 4 + len) });
    off += 4 + len;
  }
  return { packets, rest: buf.subarray(off) };
}

export function int32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
}

export function str(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const b = Buffer.alloc(2 + bytes.length);
  b.writeInt16BE(bytes.length, 0);
  bytes.copy(b, 2);
  return b;
}

const EMPTY = Buffer.alloc(0);

/**
 * O que o cliente Nitro faria sozinho em resposta a cada pacote do servidor. O cliente headless
 * passa cada pacote recebido por aqui e envia o que voltar; e avisa o que o app mandou (`noteOutgoing`)
 * para saber qual quarto está pendente.
 */
export class NitroClientEmulation {
  private pendingRoomId: number | null = null;
  private awaitingRoomUsers = false;

  get currentRoomId(): number | null {
    return this.pendingRoomId;
  }

  noteOutgoing(header: number, body: Uint8Array): void {
    if (header === H.ROOM_ENTER && body.length >= 4) {
      this.pendingRoomId = Buffer.from(body.buffer, body.byteOffset, 4).readInt32BE(0);
    }
  }

  onIncoming(header: number, body: Buffer): RawPacket[] {
    switch (header) {
      case H.PING:
        return [{ header: H.PONG, body: EMPTY }];
      case H.AUTH_OK:
        return POST_AUTH_BURST.map((h) => ({ header: h, body: EMPTY }));
      case H.USER_INFO:
        return POST_USER_INFO_BURST.map((h) => ({ header: h, body: EMPTY }));
      case H.ROOM_READY:
        this.awaitingRoomUsers = true;
        return ROOM_READY_BURST.map((h) => ({ header: h, body: EMPTY }));
      case H.ROOM_USERS: {
        if (!this.awaitingRoomUsers) return [];
        this.awaitingRoomUsers = false;
        const out: RawPacket[] = ROOM_USERS_FOLLOWUP.map((h) => ({ header: h, body: EMPTY }));
        if (this.pendingRoomId !== null) {
          out.push({ header: H.GET_GUEST_ROOM, body: Buffer.concat([int32(this.pendingRoomId), int32(1), int32(0)]) });
        }
        return out;
      }
      case H.ROOM_FORWARD: {
        // Seguir amigo / encaminhamento: sem interface, entramos direto (o Nitro faria 2230 → 687 → 2312).
        if (body.length < 4) return [];
        const roomId = body.readInt32BE(0);
        this.pendingRoomId = roomId;
        return [{ header: H.ROOM_ENTER, body: Buffer.concat([int32(roomId), str('')]) }];
      }
      default:
        return [];
    }
  }
}
