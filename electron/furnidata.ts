/**
 * Furnidata do hotel no processo principal: baixa o JSON completo (17 MB) uma vez, reduz ao catálogo compacto
 * (nome, tamanho, sentável/deitável e oferta de cada mobi; ~2 MB) e guarda em `<userData>/furnidata.json`. Renova sozinho depois de uma semana;
 * se o download falhar, usa o cache que houver (mesmo velho) e avisa.
 *
 * Sai pela sessão padrão do Electron, direto (sem proxy): é um asset público do CDN do hotel.
 */
import { app, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { FURNIDATA_URL, compactFurnidata } from '../shared/furnidata';
import type { FurniCatalog, FurniCatalogResult, WallCatalog } from '../shared/furnidata';
import { appLog } from './app-log';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Formato do cache em disco; mudar quando o catálogo ganhar campos (o cache antigo é rebaixado). */
const CACHE_VERSION = 2;
const FETCH_TIMEOUT_MS = 90_000;

interface CacheFile {
  version: number;
  fetchedAt: number;
  source: string;
  total: number;
  items: FurniCatalog;
  walls: WallCatalog;
}

let memory: CacheFile | null = null;
let inFlight: Promise<FurniCatalogResult> | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'furnidata.json');
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function readCache(): CacheFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<CacheFile>;
    if (raw.version !== CACHE_VERSION || typeof raw.fetchedAt !== 'number' || typeof raw.items !== 'object' || raw.items === null) return null;
    return {
      version: CACHE_VERSION,
      fetchedAt: raw.fetchedAt,
      source: typeof raw.source === 'string' ? raw.source : FURNIDATA_URL,
      total: typeof raw.total === 'number' ? raw.total : 0,
      items: raw.items as FurniCatalog,
      walls: (raw.walls && typeof raw.walls === 'object' ? raw.walls : {}) as WallCatalog,
    };
  } catch {
    return null;
  }
}

async function download(): Promise<CacheFile> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(FURNIDATA_URL, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o furnidata`);
    const raw: unknown = await res.json();
    const { total, items, walls } = compactFurnidata(raw);
    if (total === 0) throw new Error('furnidata sem mobis de chão (formato inesperado)');
    const file: CacheFile = { version: CACHE_VERSION, fetchedAt: Date.now(), source: FURNIDATA_URL, total, items, walls };
    try {
      fs.writeFileSync(cachePath(), JSON.stringify(file), 'utf8');
    } catch (e) {
      appLog('furnidata', `não deu para gravar o cache: ${e instanceof Error ? e.message : String(e)}`);
    }
    return file;
  } finally {
    clearTimeout(timer);
  }
}

function ok(file: CacheFile, fromCache: boolean): FurniCatalogResult {
  return { ok: true, catalog: file.items, walls: file.walls, fetchedAt: file.fetchedAt, total: file.total, fromCache };
}

/** Catálogo de mobis sentáveis/deitáveis (memória → cache em disco → download). `force` ignora o cache. */
export function getFurniCatalog(force = false): Promise<FurniCatalogResult> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<FurniCatalogResult> => {
    if (!force && memory) return ok(memory, true);
    const cached = force ? null : readCache();
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
      memory = cached;
      appLog('furnidata', `catálogo do cache: ${cached.total} mobis de chão, ${Object.keys(cached.walls).length} de parede (baixado em ${day(cached.fetchedAt)})`);
      return ok(cached, true);
    }
    try {
      const file = await download();
      memory = file;
      appLog('furnidata', `catálogo baixado: ${file.total} mobis de chão, ${Object.keys(file.walls).length} de parede`);
      return ok(file, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stale = readCache();
      if (stale) {
        memory = stale;
        appLog('furnidata', `download falhou (${msg}); usando o cache de ${day(stale.fetchedAt)}`);
        return ok(stale, true);
      }
      appLog('furnidata', `download falhou e não há cache: ${msg}`);
      return { ok: false, error: msg };
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
