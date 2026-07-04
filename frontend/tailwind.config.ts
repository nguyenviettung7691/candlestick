import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#08111f',
        panel: '#111b2e',
        accent: '#67e8f9',
        accentSoft: '#22c55e',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(103,232,249,0.15), 0 16px 48px rgba(8,17,31,0.38)',
      },
    },
  },
  plugins: [],
};

export default config;
