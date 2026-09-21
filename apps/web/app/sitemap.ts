import type { MetadataRoute } from 'next';

/**
 * app/sitemap.ts
 *
 * Agent 6 — WEB PLATFORM ENGINEER
 *
 * Lists the routes that actually exist under app/ — verified against the
 * directory, not against the spec:
 *
 *   app/page.tsx             -> /
 *   app/workout/page.tsx     -> /workout
 *   app/progress/page.tsx    -> /progress
 *   app/challenge/page.tsx   -> /challenge
 *   app/tips/page.tsx        -> /tips
 *   app/about/page.tsx       -> /about
 *   app/leaderboard/page.tsx -> /leaderboard
 *
 * Base URL convention follows lib/session-store.ts: read process.env directly
 * and fall back when the variable is absent, so an unconfigured checkout still
 * builds. The app ships no other site-URL variable.
 */

const baseUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://ai-pushup-couch.vercel.app').replace(/\/$/, '');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    // The primary tool. Everything else in the app exists to support it, so it
    // carries the highest priority rather than the landing page.
    {
      url: `${baseUrl}/workout`,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${baseUrl}/`,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    // Reference material: changes when the form engine's copy or thresholds do.
    {
      url: `${baseUrl}/tips`,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: `${baseUrl}/about`,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${baseUrl}/challenge`,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    // Per-user surfaces. They have no server-rendered content to crawl; they are
    // listed for completeness and are disallowed in app/robots.ts.
    {
      url: `${baseUrl}/progress`,
      changeFrequency: 'daily',
      priority: 0.3,
    },
    {
      url: `${baseUrl}/leaderboard`,
      changeFrequency: 'daily',
      priority: 0.3,
    },
  ];
}
