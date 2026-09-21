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
        // Deep, neutral dark surfaces
        base: {
          DEFAULT: '#0B0E14', // page background
          raised: '#131822', // cards / panels
          sunken: '#07090D', // camera letterbox
          border: '#1F2633', // subtle borders
          hover: '#1B2230',
        },
        // Clean neutral text
        ink: {
          DEFAULT: '#F3F4F6', // primary crisp white
          muted: '#9CA3AF', // secondary neutral gray
          faint: '#6B7280', // tertiary / captions
        },
        // Purposeful functional accents (used strictly for state/results)
        accent: {
          DEFAULT: '#10B981', // emerald for valid reps / good form
          dim: '#059669',
          wash: 'rgba(16, 185, 129, 0.1)',
        },
        cyan: {
          DEFAULT: '#06B6D4', // clean cyan for active telemetry
          dim: '#0891B2',
          wash: 'rgba(6, 182, 212, 0.1)',
        },
        danger: {
          DEFAULT: '#EF4444', // clean red for invalid reps / errors
          dim: '#DC2626',
          wash: 'rgba(239, 68, 68, 0.1)',
        },
        warn: {
          DEFAULT: '#F59E0B', // amber for transitions / calibration
          dim: '#D97706',
          wash: 'rgba(245, 158, 11, 0.1)',
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
        metric: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '700' }],
        metricSm: ['2rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '600' }],
        display: ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '700' }],
        label: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.08em', fontWeight: '600' }],
      },
      borderRadius: {
        card: '12px',
        control: '8px',
        chip: '6px',
      },
    },
  },
  plugins: [],
};

export default config;
