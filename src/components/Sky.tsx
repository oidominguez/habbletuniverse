import { memo, useMemo } from 'react';

/**
 * O céu do Universe: vácuo, estrelas que cintilam fora de fase e duas nebulosas quase invisíveis que
 * derivam devagar. Fica atrás do jogo (aparece nas bordas e quando a página ainda não carregou) e no
 * estado vazio. É o MESMO céu em toda tela: a semente é fixa, então as estrelas não "pulam" entre
 * renders nem entre abas.
 */
export interface SkyProps {
  /** Quantas estrelas. 90 para o palco, 140 para a abertura. */
  stars?: number;
  seed?: number;
  /** Nebulosa ligada (desligue onde houver texto denso por cima). */
  nebula?: boolean;
  className?: string;
}

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  delay: number;
  dur: number;
  tint: string;
}

function makeStars(n: number, seed: number): Star[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: Star[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * 100;
    const y = rnd() * 100;
    const r = 0.6 + rnd() * 1.1;
    const o = 0.25 + rnd() * 0.6;
    const delay = rnd() * 6;
    const dur = 4 + rnd() * 5;
    const t = rnd();
    out.push({ x, y, r, o, delay, dur, tint: t > 0.92 ? '#F2E4C4' : t > 0.8 ? '#BFE3FF' : '#F4F6FB' });
  }
  return out;
}

export const Sky = memo(function Sky({ stars = 90, seed = 7, nebula = true, className }: SkyProps) {
  const list = useMemo(() => makeStars(stars, seed), [stars, seed]);
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ''}`}>
      {nebula && (
        <>
          <div className="nebula-a animate-drift" />
          <div className="nebula-b animate-drift-2" />
        </>
      )}
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {list.map((st, i) => (
          <circle
            key={i}
            className="star"
            cx={st.x}
            cy={st.y}
            r={st.r * 0.09}
            fill={st.tint}
            opacity={st.o}
            style={{ animationDelay: `${st.delay}s`, animationDuration: `${st.dur}s` }}
          />
        ))}
      </svg>
    </div>
  );
});

/** Ponto "vivo": pulsa como um farol. Use só para o que está acontecendo agora (online, agente ativo). */
export function LiveDot({ size = 6, tone = 'accent', className }: { size?: number; tone?: 'accent' | 'success' | 'warn' | 'danger'; className?: string }) {
  const bg = { accent: 'bg-accent', success: 'bg-success', warn: 'bg-warn', danger: 'bg-danger' }[tone];
  return (
    <span className={`relative inline-block shrink-0 ${className ?? ''}`} style={{ width: size, height: size }}>
      <span className={`absolute inset-0 rounded-full ${bg} animate-pulsar`} />
      <span className={`absolute inset-0 rounded-full ${bg}`} />
    </span>
  );
}
