import type { MetadataRoute } from 'next';

/**
 * app/manifest.ts
 *
 * Colours match the light design tokens in tailwind.config.ts.
 */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AI Push-Up Coach',
    short_name: 'Push-Up Coach',
    description:
      'Real-time push-up form analysis using on-device pose estimation. Counts reps, detects form faults, and scores your technique.',
    start_url: '/',
    display: 'standalone',
    background_color: '#FAFAFA',
    theme_color: '#FAFAFA',
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
