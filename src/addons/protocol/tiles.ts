/** Geometria das casas do quarto, compartilhada pelos motores de perseguição e de postura. */

export interface Tile {
  x: number;
  y: number;
}

export function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

export function parseTileKey(key: string): Tile {
  const [x, y] = key.split(',').map((v) => parseInt(v, 10));
  return { x, y };
}

/** Distância de Chebyshev (o jogo considera vizinho quem está a 1 casa em qualquer direção, inclusive diagonal). */
export function tileDistance(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * As casas do anel a `radius` casas do alvo (8 no primeiro anel, 16 no segundo), da mais próxima de nós
 * para a mais longe (empate: a que exige menos passos em linha reta). Não conhecemos a ocupação do quarto
 * (heightmap não é decodificado), então quem usa tenta uma por vez: se o servidor não nos move, a próxima
 * da lista é a alternativa.
 */
export function approachTiles(target: Tile, me: Tile | null, radius = 1): Tile[] {
  const tiles: Tile[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) tiles.push({ x: target.x + dx, y: target.y + dy });
  if (!me) return tiles;
  const manhattan = (t: Tile) => Math.abs(t.x - me.x) + Math.abs(t.y - me.y);
  return tiles.sort((a, b) => tileDistance(a, me) - tileDistance(b, me) || manhattan(a) - manhattan(b));
}
