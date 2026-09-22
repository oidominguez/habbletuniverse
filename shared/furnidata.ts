/**
 * Catálogo compacto do furnidata do hotel: só o que interessa para agir por protocolo — nome (classe) de
 * cada mobi, quantas casas ocupa, se dá para sentar/deitar e a oferta do catálogo para comprá-lo. O arquivo
 * completo do Habblet tem 17 MB; aqui ficam ~6 campos por mobi, indexados pelo `spriteId` (o `id` do
 * furnidata, que é o que os pacotes 1778/1534/3776 e 1369 trazem em cada mobi).
 *
 * Só tipos e funções puras: compartilhado entre o processo principal (que baixa e guarda) e o renderer.
 */

/** URL do furnidata no hotel (lida do renderer-config.json do cliente em 20/09/2026: `${gamedata.url}/habblet_furni.json`). */
export const FURNIDATA_URL = 'https://images.habblet.city/habblet-asset-bundles/gamedata/habblet_furni.json';

export interface FurniInfo {
  /** `classname` do furnidata (ex.: `chair_plasto`), para o log e o clone de quarto. */
  name: string;
  /** Casas ocupadas com o mobi na direção 0/4; nas direções 2/6 os eixos trocam. */
  xdim: number;
  ydim: number;
  sit: boolean;
  lay: boolean;
  /** Oferta no catálogo (`offerid`); -1 = não está à venda (raros, eventos). */
  offerId: number;
}

export interface WallFurniInfo {
  name: string;
  offerId: number;
}

/** spriteId → mobi de chão (todos os 37 mil, não só os sentáveis). */
export type FurniCatalog = Record<number, FurniInfo>;
/** spriteId → mobi de parede. */
export type WallCatalog = Record<number, WallFurniInfo>;

export type FurniCatalogResult =
  | { ok: true; catalog: FurniCatalog; walls: WallCatalog; fetchedAt: number; total: number; fromCache: boolean }
  | { ok: false; error: string };

interface RawFurniType {
  id?: unknown;
  classname?: unknown;
  xdim?: unknown;
  ydim?: unknown;
  cansiton?: unknown;
  canlayon?: unknown;
  offerid?: unknown;
}

function listOf(section: unknown): unknown[] {
  if (Array.isArray(section)) return section;
  if (section && typeof section === 'object' && Array.isArray((section as { furnitype?: unknown }).furnitype)) return (section as { furnitype: unknown[] }).furnitype;
  return [];
}

function dim(v: unknown): number {
  return typeof v === 'number' && v > 0 ? v : 1;
}

function offer(v: unknown): number {
  return typeof v === 'number' ? v : -1;
}

/**
 * Reduz o JSON do furnidata (`{ roomitemtypes: { furnitype: [...] }, wallitemtypes: { furnitype: [...] } }`)
 * aos catálogos. Devolve também o total de mobis de chão lidos, para o log. Tolerante a formato: aceita a
 * lista direto em `roomitemtypes`.
 */
export function compactFurnidata(raw: unknown): { total: number; items: FurniCatalog; walls: WallCatalog } {
  const root = (raw ?? {}) as { roomitemtypes?: unknown; wallitemtypes?: unknown };
  const items: FurniCatalog = {};
  const walls: WallCatalog = {};
  let total = 0;
  for (const entry of listOf(root.roomitemtypes)) {
    const f = entry as RawFurniType;
    if (typeof f.id !== 'number') continue;
    total++;
    items[f.id] = {
      name: typeof f.classname === 'string' ? f.classname : String(f.id),
      xdim: dim(f.xdim),
      ydim: dim(f.ydim),
      sit: f.cansiton === true,
      lay: f.canlayon === true,
      offerId: offer(f.offerid),
    };
  }
  for (const entry of listOf(root.wallitemtypes)) {
    const f = entry as RawFurniType;
    if (typeof f.id !== 'number') continue;
    walls[f.id] = { name: typeof f.classname === 'string' ? f.classname : String(f.id), offerId: offer(f.offerid) };
  }
  return { total, items, walls };
}

export interface FootprintItem {
  x: number;
  y: number;
  direction: number;
}

/**
 * Casas que o mobi cobre. Direção 2 ou 6 = mobi girado: largura e profundidade trocam (mesma regra do
 * cliente). Sem informação de tamanho, vale a casa base.
 */
export function furniFootprint(item: FootprintItem, info?: Pick<FurniInfo, 'xdim' | 'ydim'> | null): { x: number; y: number }[] {
  const w = info && info.xdim > 0 ? info.xdim : 1;
  const d = info && info.ydim > 0 ? info.ydim : 1;
  const rotated = item.direction === 2 || item.direction === 6;
  const spanX = rotated ? d : w;
  const spanY = rotated ? w : d;
  const out: { x: number; y: number }[] = [];
  for (let dx = 0; dx < spanX; dx++) for (let dy = 0; dy < spanY; dy++) out.push({ x: item.x + dx, y: item.y + dy });
  return out;
}
