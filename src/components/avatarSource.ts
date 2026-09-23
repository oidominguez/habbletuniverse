/**
 * De onde vem a foto de um avatar (só a cabeça) e o cache do visual por nick.
 *
 * Fonte, nesta ordem: o código do visual (`figure`) que o protocolo já entregou (2725 para a própria conta,
 * 374 para quem está na sala, 3130/2800 para amigos, 2219 para pedidos) → imaging do hotel; senão o último
 * visual visto para esse nick, guardado no navegador; senão o nick, pelo imager do fansite (funciona com a
 * pessoa offline; é o que a Multidão usa antes do login).
 */
const IMAGING = 'https://imaging.habblet.city/avatarimage';
const FANSITE_IMAGER = 'https://api.radiohabblet.com.br/imager';
const CACHE_PREFIX = 'universe:figure:';

/** Geometria da imagem só-cabeça: quadro de 180×260 com a cabeça mais ou menos em (56–130, 74–142). */
export const HEAD_FRAME = { w: 180, h: 260, headCx: 93, headCy: 108, headW: 74 };

export function avatarUrlByFigure(figure: string): string {
  return `${IMAGING}?figure=${encodeURIComponent(figure)}&direction=2&head_direction=3&size=l&headonly=1&img_format=png`;
}

export function avatarUrlByName(name: string): string {
  return `${FANSITE_IMAGER}?user=${encodeURIComponent(name)}&size=l&headonly=1&direction=2&head_direction=3`;
}

/** Guarda o visual visto para um nick (chave em minúsculas). Silencioso se o storage não existir. */
export function rememberFigure(name: string, figure: string | null | undefined): void {
  if (!name || !figure) return;
  try {
    const key = CACHE_PREFIX + name.toLowerCase();
    if (localStorage.getItem(key) !== figure) localStorage.setItem(key, figure);
  } catch {
    /* sem storage */
  }
}

export function recallFigure(name: string): string | null {
  if (!name) return null;
  try {
    return localStorage.getItem(CACHE_PREFIX + name.toLowerCase());
  } catch {
    return null;
  }
}

/** URL da foto para este nick/visual, ou null quando não há nem nick. */
export function avatarSource(name: string, figure?: string | null): string | null {
  const fig = figure || recallFigure(name);
  if (fig) return avatarUrlByFigure(fig);
  return name ? avatarUrlByName(name) : null;
}
