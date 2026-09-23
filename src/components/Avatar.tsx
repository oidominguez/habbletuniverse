import { useEffect, useState } from 'react';
import { cx } from './cx';
import { HEAD_FRAME, avatarSource, rememberFigure } from './avatarSource';

/**
 * Foto do avatar (só a cabeça), como nas linhas da Multidão e da Sala. A fonte da imagem e o cache do visual
 * estão em avatarSource.ts. Sem imagem (ou se ela falhar), mostra a inicial.
 *
 * A imagem só-cabeça vem num quadro de 180×260: o <img> é ampliado e deslocado para a cabeça preencher o
 * círculo. Pixel art: sem suavização.
 */
export interface AvatarProps {
  name: string;
  figure?: string | null;
  /** Diâmetro em px. */
  size?: number;
  /** Anel orbital fino girando devagar (linhas de conta). */
  ring?: boolean;
  /** Anel rápido (a própria conta na ilha). */
  ringFast?: boolean;
  /** Conta desconectada: foto esmaecida. */
  dim?: boolean;
  className?: string;
  title?: string;
}

export function Avatar({ name, figure, size = 30, ring, ringFast, dim, className, title }: AvatarProps) {
  const src = avatarSource(name, figure);
  // Uma fonte que falhou fica marcada; trocar de fonte (visual chegou) tenta de novo sem precisar de efeito.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  useEffect(() => {
    rememberFigure(name, figure);
  }, [name, figure]);

  const scale = (size * 0.86) / HEAD_FRAME.headW;
  const imgStyle = {
    position: 'absolute' as const,
    width: HEAD_FRAME.w * scale,
    height: HEAD_FRAME.h * scale,
    left: size / 2 - HEAD_FRAME.headCx * scale,
    top: size / 2 - HEAD_FRAME.headCy * scale,
    imageRendering: 'pixelated' as const,
    maxWidth: 'none',
  };
  const outer = ring || ringFast ? size + 8 : size;

  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: outer, height: outer }} title={title}>
      {(ring || ringFast) && (
        <span className={cx('absolute inset-0 rounded-full border border-line-strong', ringFast ? 'animate-orbit border-t-fg/70' : 'animate-orbit-slow border-t-fg/50')} />
      )}
      <span className={cx('relative block overflow-hidden rounded-full bg-raised', dim && 'opacity-55 grayscale')} style={{ width: size, height: size }}>
        {src && !failed ? (
          <img src={src} alt="" draggable={false} style={imgStyle} onError={() => setFailedSrc(src)} />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-display font-semibold text-fg-2" style={{ fontSize: Math.max(9, Math.round(size * 0.42)) }}>
            {name ? name.slice(0, 1).toUpperCase() : '·'}
          </span>
        )}
      </span>
    </span>
  );
}
