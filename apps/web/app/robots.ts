import type { MetadataRoute } from 'next';

/**
 * app/robots.ts
 *
 * Agent 6 — WEB PLATFORM ENGINEER
 *
 * This app points a camera at the user and records personal fitness history.
 * Two consequences for crawlers:
 *
 *   /workout    A live training screen. There is no static content to index,
 *               and the camera-permission prompt is the only thing a crawler
 *               would ever see. Indexing it would put a page in search results
 *               that cannot work for anyone arriving cold from a search.
 *
 *   /progress   Renders the local workout history of whoever opened the page.
 *               It is per-user and meaningless — and slightly revealing — to a
 *               crawler, so it is kept out of the index entirely.
 *
 * The informational routes stay open. `/leaderboard` is also excluded: every
 * row lives in the visitor's localStorage, so a crawler sees only an empty
 * skeleton. It is not disallowed here only because it is client-rendered and
 * contains no server-side personal data; if it ever gains a server-rendered
 * name list, it should move to the disallow list.
 */

const baseUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://ai-pushup-coach.vercel.app').replace(/\/$/, '');

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/tips', '/about', '/challenge'],
      disallow: ['/workout', '/progress', '/lab'],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
