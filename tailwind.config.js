/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Paleta "Ink & Mint": tinta profunda com um único acento menta. Tokens, nunca hex solto.
      colors: {
        bg: '#0a0d12',
        surface: '#10151c',
        raised: '#161d26',
        line: '#232c38',
        'line-strong': '#2f3a48',
        fg: '#e9eef5',
        'fg-2': '#c3ccd8',
        muted: '#8b97a8',
        dim: '#5d6a7c',
        accent: '#6ee7c7',
        'accent-strong': '#3ccfa5',
        'accent-ink': '#06231b',
        info: '#6ea8ff',
        'info-strong': '#4f8df5',
        success: '#5bd987',
        'success-strong': '#3fc46c',
        warn: '#f6c35b',
        'warn-strong': '#e0a83a',
        danger: '#ff6b6b',
        violet: '#b3a7ff',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', '"Cascadia Mono"', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(110, 231, 199, 0.35), 0 0 24px rgba(110, 231, 199, 0.15)',
        dock: '0 -12px 40px rgba(0, 0, 0, 0.45)',
        drawer: '-24px 0 60px rgba(0, 0, 0, 0.55)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'pulse-dot': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'slide-in-right': 'slide-in-right 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
