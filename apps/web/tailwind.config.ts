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
        // Deep obsidian carbon surfaces
        base: {
          DEFAULT: '#070A0E', // page background
          raised: '#0F161E', // cards
          sunken: '#030508', // camera letterbox
          border: '#1C2733', // hairline borders
          hover: '#15202B',
        },
        // Text
        ink: {
          DEFAULT: '#F0F4F8', // primary crisp white
          muted: '#8A99A8', // secondary cool gray
          faint: '#526270', // tertiary / labels
        },
        // Accent — cyber emerald for valid reps, target depth, and success
        accent: {
          DEFAULT: '#00F090',
          dim: '#059669',
          deep: '#064E3B',
          wash: 'rgba(0, 240, 144, 0.08)',
        },
        // Laser Cyan — for telemetry, angles, radar, and active indicators
        cyan: {
          DEFAULT: '#00E5FF',
          dim: '#0891B2',
          wash: 'rgba(0, 229, 255, 0.08)',
        },
        // Athletic Crimson — for invalid reps, form breaks, and stop actions
        danger: {
          DEFAULT: '#FF3B5C',
          dim: '#BE123C',
          wash: 'rgba(255, 59, 92, 0.08)',
        },
        // Electric Amber — for calibration, phase transitions, and warnings
        warn: {
          DEFAULT: '#FFB800',
          dim: '#D97706',
          wash: 'rgba(255, 184, 0, 0.08)',
        },
      },
      fontFamily: {
        sans: [
          'Outfit',
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        display: [
          '"Barlow Condensed"',
          'Outfit',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Cascadia Mono',
          'monospace',
        ],
      },
      fontSize: {
        metric: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '800' }],
        metricSm: ['2.25rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '700' }],
        display: ['2.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }],
        label: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.1em', fontWeight: '600' }],
      },
      borderRadius: {
        card: '12px',
        control: '10px',
        chip: '8px',
      },
      spacing: {
        gutter: '1.25rem',
      },
      boxShadow: {
        card: '0 4px 20px -2px rgba(0, 0, 0, 0.5)',
        raised: '0 8px 32px -4px rgba(0, 0, 0, 0.65)',
        glow: '0 0 24px -4px rgba(0, 240, 144, 0.4)',
        'glow-accent': '0 0 24px -4px rgba(0, 240, 144, 0.35)',
        'glow-cyan': '0 0 24px -4px rgba(0, 229, 255, 0.35)',
        'glow-sm': '0 0 12px -2px rgba(0, 240, 144, 0.25)',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.85)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
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
