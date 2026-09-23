/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Paleta "Universe": espaço profundo com um toque de índigo, luz estelar para texto e ação,
      // um só acento ("pulsar") para o que está vivo agora. Os NOMES dos tokens são os mesmos do
      // tema anterior, então todo componente continua válido; só a cor muda. Nunca hex solto.
      colors: {
        bg: '#05060B', // vácuo
        surface: '#090B14', // palco
        raised: '#10131E',
        line: '#1A2030',
        'line-strong': '#28304A',
        fg: '#F4F6FB', // luz estelar
        'fg-2': '#C9CFDC',
        muted: '#A3A9B8',
        dim: '#6B7285',
        accent: '#8FD3FF', // pulsar
        'accent-strong': '#B7E4FF',
        'accent-ink': '#05060B',
        info: '#8FB8FF',
        'info-strong': '#A9C9FF',
        success: '#7FE0C3',
        'success-strong': '#A6EDD8',
        warn: '#F2C97D', // solar
        'warn-strong': '#F7D89B',
        danger: '#FF8E8E', // nova
        violet: '#B9B0FF',
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'Manrope', '-apple-system', '"Segoe UI Variable"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Space Grotesk"', '"Manrope Variable"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', '"Cascadia Mono"', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 3px rgba(143, 211, 255, 0.18)',
        float: '0 12px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(244, 246, 251, 0.06)',
        dock: '0 16px 48px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(244, 246, 251, 0.06)',
        sheet: '0 24px 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(244, 246, 251, 0.06)',
        drawer: '-24px 0 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(244, 246, 251, 0.06)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'pulse-dot': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        rise: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        orbit: { to: { transform: 'rotate(360deg)' } },
        pulsar: { '0%': { transform: 'scale(1)', opacity: '0.55' }, '100%': { transform: 'scale(3)', opacity: '0' } },
        twinkle: { '0%, 100%': { opacity: '0.18' }, '50%': { opacity: '0.95' } },
        drift: { '0%, 100%': { transform: 'translate3d(0, 0, 0)' }, '50%': { transform: 'translate3d(60px, -40px, 0)' } },
        'drift-2': { '0%, 100%': { transform: 'translate3d(0, 0, 0)' }, '50%': { transform: 'translate3d(-50px, 30px, 0)' } },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'slide-in-right': 'slide-in-right 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
        rise: 'rise 480ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        orbit: 'orbit 14s linear infinite',
        'orbit-slow': 'orbit 40s linear infinite',
        pulsar: 'pulsar 2.4s cubic-bezier(0.2, 0.7, 0.3, 1) infinite',
        drift: 'drift 46s ease-in-out infinite',
        'drift-2': 'drift-2 58s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
