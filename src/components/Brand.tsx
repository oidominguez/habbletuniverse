/**
 * Marca do Universe: um núcleo, uma órbita e um satélite em movimento contínuo (o app orbita o jogo),
 * e o wordmark UNIVERSE em caixa alta com entreletra larga. Só CSS (index.css: .brand-mark, .wordmark).
 */
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <div aria-hidden className={`brand-mark ${className ?? ''}`} style={{ width: size, height: size }}>
      <span />
    </div>
  );
}

export function Wordmark({ className, size = 12.5 }: { className?: string; size?: number }) {
  return (
    <span className={`wordmark text-fg ${className ?? ''}`} style={{ fontSize: size }}>
      Universe
    </span>
  );
}
