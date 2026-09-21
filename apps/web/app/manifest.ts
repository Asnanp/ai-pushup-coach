import type { MetadataRoute } from 'next';

/**
 * app/manifest.ts
 *
 * Agent 6 — WEB PLATFORM ENGINEER
 *
 * Web app manifest. Colours match the design tokens in tailwind.config.ts:
 * `base.DEFAULT` (#0B1117) is the page background and the value already used by
 * the `viewport.themeColor` export in app/layout.tsx, so the browser chrome and
 * the app background agree.
 *
 * The icon points at app/icon.svg, which Next.js serves at /icon.svg. No files
 * exist in apps/web/public/, so there is nothing else to reference.
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AI Push-Up Coach',
    short_name: 'Push-Up Coach',
    description:
      'Real-time push-up form analysis using on-device pose estimation. Counts reps, detects form faults, and scores your technique.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0B1117',
    theme_color: '#0B1117',
    icons: [
      {
        src: '/icon.svg',
        type: 'image/svg+xml',
        sizes: 'any',
        purpose: 'any',
      },
    ],
  };
}
