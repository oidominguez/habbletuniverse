/**
 * "Copiar quarto": transforma o que o GameState sabe do quarto atual num arquivo JSON autocontido — planta,
 * porta, pintura, mobis de chão (posição, altura, direção, estado) e de parede — pronto para ser lido de volta
 * pela etapa de "colar" e para gerar a lista de compras no catálogo. Puro: sem React, sem Electron.
 */
import type { FurniCatalog, WallCatalog } from '../../shared/furnidata';
import type { GameSnapshot } from './state/GameState';

export const ROOM_COPY_VERSION = 1;

export interface RoomCopyFloorItem {
  /** Id do mobi no quarto de origem (só para referência; muda ao comprar). */
  id: number;
  /** Tipo (id do furnidata). */
  type: number;
  /** Classe do furnidata, quando o catálogo conhece o tipo. */
  name: string | null;
  x: number;
  y: number;
  direction: number;
  z: number;
  stackHeight: number;
  state: string;
  /** Tipo dos dados extras do mobi (0 = estado simples). */
  dataKind: number;
  /** Campo `extra` do mobi no protocolo (flags do servidor). */
  extra: number;
  /** Oferta no catálogo; -1 = não está à venda; null = tipo fora do furnidata. */
  offerId: number | null;
}

export interface RoomCopyWallItem {
  id: string;
  type: number;
  name: string | null;
  /** `:w=x,y l=x,y l|r` — posição na parede no formato do cliente. */
  position: string;
  state: string;
  offerId: number | null;
}

export interface RoomCopyShoppingLine {
  type: number;
  name: string | null;
  kind: 'floor' | 'wall';
  count: number;
  offerId: number | null;
}

export interface RoomCopy {
  version: number;
  capturedAt: string;
  hotel: string;
  room: { id: number | null; name: string | null; ownerName: string | null };
  floorPlan: {
    /** Uma linha por y; `x` = sem chão, dígito/letra = altura do piso. */
    rows: string[];
    wallHeight: number;
    width: number;
    height: number;
    door: { x: number; y: number; direction: number } | null;
  } | null;
  /** `floor`, `wallpaper`, `landscape`. */
  paint: Record<string, string>;
  /** Altura do topo de cada casa (piso + mobis), linhas por y; null = sem chão. */
  heights: (number | null)[][] | null;
  floorItems: RoomCopyFloorItem[];
  wallItems: RoomCopyWallItem[];
  /** Lista de compras: um item por tipo, com quantidade; `offerId` -1 marca o que não está à venda. */
  shopping: RoomCopyShoppingLine[];
  summary: {
    floorItems: number;
    wallItems: number;
    /** Mobis (unidades) que dá para comprar no catálogo. */
    purchasable: number;
    /** Mobis (unidades) sem oferta (raros, eventos) ou fora do furnidata. */
    notPurchasable: number;
    /** Tipos diferentes. */
    types: number;
    hasFloorPlan: boolean;
    hasDoor: boolean;
    hasWallItems: boolean;
  };
}

/**
 * Lista de compras a partir das listas de mobis: uma linha por tipo, com a contagem. Usada ao copiar o
 * quarto e de novo ao continuar uma construção interrompida, para refazer a lista só com o que falta.
 */
export function shoppingFor(floorItems: readonly RoomCopyFloorItem[], wallItems: readonly RoomCopyWallItem[]): RoomCopyShoppingLine[] {
  const lines = new Map<string, RoomCopyShoppingLine>();
  const add = (kind: 'floor' | 'wall', type: number, name: string | null, offerId: number | null) => {
    const key = `${kind}:${type}`;
    const cur = lines.get(key);
    if (cur) cur.count++;
    else lines.set(key, { type, name, kind, count: 1, offerId });
  };
  for (const it of floorItems) add('floor', it.type, it.name, it.offerId);
  for (const it of wallItems) add('wall', it.type, it.name, it.offerId);
  return [...lines.values()].sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** Monta a cópia a partir do snapshot atual. Funciona parcialmente sem catálogo (nomes e ofertas ficam null). */
export function buildRoomCopy(snapshot: GameSnapshot, catalog: FurniCatalog | null, walls: WallCatalog | null, now = new Date()): RoomCopy {
  const room = snapshot.room;
  const floorItems: RoomCopyFloorItem[] = [...room.floorItems]
    .sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || a.id - b.id)
    .map((it) => {
      const info = catalog?.[it.spriteId];
      return {
        id: it.id,
        type: it.spriteId,
        name: info?.name ?? it.staticClass ?? null,
        x: it.x,
        y: it.y,
        direction: it.direction,
        z: it.z,
        stackHeight: it.stackHeight,
        state: it.state,
        dataKind: it.dataKind,
        extra: it.extra,
        offerId: info ? info.offerId : null,
      };
    });
  const wallItems: RoomCopyWallItem[] = [...room.wallItems].map((it) => {
    const info = walls?.[it.spriteId];
    return { id: it.id, type: it.spriteId, name: info?.name ?? null, position: it.wallPosition, state: it.state, offerId: info ? info.offerId : null };
  });

  const shopping = shoppingFor(floorItems, wallItems);
  const purchasable = shopping.filter((l) => l.offerId !== null && l.offerId >= 0).reduce((n, l) => n + l.count, 0);

  const plan = room.floorPlan;
  const heightMap = room.heightMap;
  let heights: (number | null)[][] | null = null;
  if (heightMap && heightMap.width > 0) {
    heights = [];
    for (let y = 0; y < heightMap.height; y++) heights.push(heightMap.heights.slice(y * heightMap.width, (y + 1) * heightMap.width));
  }

  return {
    version: ROOM_COPY_VERSION,
    capturedAt: now.toISOString(),
    hotel: 'habblet.city',
    room: { id: room.id, name: room.name, ownerName: room.ownerName },
    floorPlan: plan
      ? { rows: plan.rows, wallHeight: plan.wallHeight, width: plan.rows.reduce((m, r) => Math.max(m, r.length), 0), height: plan.rows.length, door: room.door }
      : null,
    paint: { ...room.paint },
    heights,
    floorItems,
    wallItems,
    shopping,
    summary: {
      floorItems: floorItems.length,
      wallItems: wallItems.length,
      purchasable,
      notPurchasable: floorItems.length + wallItems.length - purchasable,
      types: shopping.length,
      hasFloorPlan: plan !== null,
      hasDoor: room.door !== null,
      hasWallItems: wallItems.length > 0,
    },
  };
}

/** Nome de arquivo seguro para a cópia. */
export function roomCopyFileName(copy: RoomCopy): string {
  const name = (copy.room.name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = copy.capturedAt.slice(0, 19).replace(/[:T]/g, '-');
  return `quarto-${copy.room.id ?? 'sem-id'}${name ? '-' + name : ''}-${stamp}.json`;
}

/** Frase curta para o toast. */
export function describeRoomCopy(copy: RoomCopy): string {
  const s = copy.summary;
  const parts = [`${s.floorItems} mobi(s) de chão`, `${s.wallItems} de parede`];
  if (s.notPurchasable > 0) parts.push(`${s.notPurchasable} sem oferta no catálogo`);
  if (!s.hasFloorPlan) parts.push('sem planta');
  if (!s.hasDoor) parts.push('sem porta');
  return parts.join(' · ');
}
