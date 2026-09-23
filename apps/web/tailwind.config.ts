/**
 * apps/web/tailwind.config.ts
 *
 * Light, Linear-tight product tokens:
 * off-white canvas, white raised panels, one restrained blue accent for CTAs,
 * success green reserved for real form-good / valid states.
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
        base: {
          DEFAULT: '#FAFAFA',
          raised: '#FFFFFF',
          sunken: '#F4F4F5',
          border: '#E4E4E7',
          hover: '#F4F4F5',
        },
        ink: {
          DEFAULT: '#0A0A0A',
          muted: '#71717A',
          faint: '#A1A1AA',
        },
        accent: {
          DEFAULT: '#2563EB',
          dim: '#1D4ED8',
          wash: 'rgba(37, 99, 235, 0.08)',
        },
        success: {
          DEFAULT: '#16A34A',
          dim: '#15803D',
          wash: 'rgba(22, 163, 74, 0.10)',
        },
        cyan: {
          DEFAULT: '#0891B2',
          dim: '#0E7490',
          wash: 'rgba(8, 145, 178, 0.10)',
        },
        danger: {
          DEFAULT: '#DC2626',
          dim: '#B91C1C',
          wash: 'rgba(220, 38, 38, 0.10)',
        },
        warn: {
          DEFAULT: '#D97706',
          dim: '#B45309',
          wash: 'rgba(217, 119, 6, 0.10)',
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
        card: '10px',
        control: '8px',
        chip: '6px',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(10, 10, 10, 0.04), 0 1px 3px rgba(10, 10, 10, 0.06)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease-out',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
