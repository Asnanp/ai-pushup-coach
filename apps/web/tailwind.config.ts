/**
 * apps/web/tailwind.config.ts
 *
 * Minimalist design tokens:
 * Clean, restrained dark theme. Subtle borders, high contrast typography,
 * zero decorative clutter or artificial glow.
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Architectural Swiss editorial palette (off-white canvas, pure white cards)
        base: {
          DEFAULT: '#F9F9F8', // clean editorial off-white
          raised: '#FFFFFF', // pure white card surface
          sunken: '#F0F0EE', // subtle sunken surface
          border: '#E5E5E3', // crisp hairline border
          hover: '#EBEBE8',
        },
        // High contrast editorial typography
        ink: {
          DEFAULT: '#111111', // deep charcoal / black
          muted: '#555555', // clean editorial body gray
          faint: '#888888', // subtle index numbering / captions
        },
        // High-contrast primary action (solid black)
        accent: {
          DEFAULT: '#111111',
          dim: '#262626',
          wash: 'rgba(0, 0, 0, 0.05)',
        },
        // Functional telemetry accents
        cyan: {
          DEFAULT: '#0284C7',
          dim: '#0369A1',
          wash: 'rgba(2, 132, 199, 0.08)',
        },
        danger: {
          DEFAULT: '#DC2626',
          dim: '#B91C1C',
          wash: 'rgba(220, 38, 38, 0.08)',
        },
        warn: {
          DEFAULT: '#D97706',
          dim: '#B45309',
          wash: 'rgba(217, 119, 6, 0.08)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'Outfit',
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'monospace',
        ],
      },
      fontSize: {
        metric: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.04em', fontWeight: '700' }],
        metricSm: ['2rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '600' }],
        display: ['2.5rem', { lineHeight: '1.08', letterSpacing: '-0.04em', fontWeight: '700' }],
        label: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.08em', fontWeight: '600' }],
      },
      borderRadius: {
        card: '16px',
        control: '9999px',
        chip: '9999px',
      },
    },
  },
  plugins: [],
};

export default config;
