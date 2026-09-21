/**
 * apps/web/tailwind.config.ts
 *
 * Agent 3 — UI DESIGN SYSTEM ENGINEER
 *
 * Design tokens derived from the supplied reference screenshot.
 *
 * Anti-generic-AI direction: this is a tool for a school IT fest, not an AI
 * product landing page. That means restrained neutrals, ONE accent colour used
 * sparingly, tight radii, thin borders, and no decorative gradients or glow.
 * The camera feed is the visual hero; the chrome stays quiet so it does not
 * compete.
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
        // Surfaces — a cool near-black, deliberately not pure #000 so borders
        // and shadows read against it.
        base: {
          DEFAULT: '#0B1117', // page background
          raised: '#121A22', // cards
          sunken: '#080D12', // camera letterbox
          border: '#1E2A35', // hairline borders
          hover: '#18222C',
        },
        // Text
        ink: {
          DEFAULT: '#E8EDF2', // primary off-white
          muted: '#8A99A8', // secondary cool gray
          faint: '#5A6875', // tertiary / labels
        },
        // Accent — soft green. Used for: primary state, valid reps, success.
        // Deliberately not used for buttons, links, headers, or decoration,
        // so it retains meaning.
        accent: {
          DEFAULT: '#7DD87D',
          dim: '#4FA85A',
          deep: '#2E6B39',
          wash: '#12240F', // very subtle tinted background
        },
        // Restrained semantic colours
        danger: {
          DEFAULT: '#E5484D',
          dim: '#A02B2F',
          wash: '#2A0F10',
        },
        warn: {
          DEFAULT: '#E0A33A',
          wash: '#2A1F0A',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Cascadia Mono',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // Metric numerals must be readable from several metres away at an
        // IT-fest booth — this is why `metric` is so large.
        metric: ['3.25rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '700' }],
        metricSm: ['2rem', { lineHeight: '1', letterSpacing: '-0.01em', fontWeight: '700' }],
        display: ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '600' }],
        label: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.08em', fontWeight: '600' }],
      },
      borderRadius: {
        // Tight. Large pills everywhere is the generic-AI look we are avoiding.
        card: '10px',
        control: '8px',
        chip: '6px',
      },
      spacing: {
        gutter: '1.25rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.4)',
        raised: '0 4px 16px rgba(0,0,0,0.45)',
      },
      keyframes: {
        // The only looping animation in the app: the LIVE indicator pulse.
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 220ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
