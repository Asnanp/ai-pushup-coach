import Link from 'next/link';

/**
 * app/not-found.tsx
 *
 * Agent 6 — WEB PLATFORM ENGINEER
 *
 * The 404 page. Server component, rendered inside the root layout, so the
 * header and footer are already present and are not repeated here.
 *
 * Tone is deliberately flat: someone who mistyped a URL or followed a stale
 * link wants to know what happened and where to go next, not a joke. The list
 * below is limited to routes that actually have a page.tsx under app/.
 */

const ROUTES = [
  {
    href: '/',
    label: 'Home',
    description: 'What the coach measures, and how a session works.',
  },
  {
    href: '/workout',
    label: 'Workout',
    description: 'The main training screen: live camera, rep counter, and per-rep feedback.',
  },
  {
    href: '/progress',
    label: 'Progress',
    description: 'Workout history, summary totals, and trend charts.',
  },
  {
    href: '/tips',
    label: 'Tips',
    description: 'How to fix each form fault the coach detects.',
  },
  {
    href: '/about',
    label: 'About',
    description: 'Project background, privacy, and contact.',
  },
  {
    href: '/challenge',
    label: 'Challenge',
    description: '30-second exhibition mode: your maximum valid reps.',
  },
] as const;

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-16">
      <div className="mx-auto max-w-xl">
        <p className="text-label uppercase text-ink-muted">Error 404</p>

        <h1 className="mt-3 text-display font-semibold tracking-tight text-ink">Page not found</h1>

        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
          This address does not match any page in the app. Nothing has gone wrong with your data —
          the page you asked for simply does not exist.
        </p>

        <nav aria-label="Available pages" className="mt-9">
          <h2 className="text-label uppercase text-ink-muted">Pages that do exist</h2>

          <ul className="card mt-3 divide-y divide-base-border">
            {ROUTES.map((route) => (
              <li key={route.href}>
                <Link
                  href={route.href}
                  className="flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-base-hover"
                >
                  <span className="font-mono text-sm text-ink">{route.href}</span>
                  <span className="text-xs leading-relaxed text-ink-muted">{route.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/" className="btn-primary">
            Back to home
          </Link>
          <Link href="/workout" className="btn-secondary">
            Start a workout
          </Link>
        </div>
      </div>
    </div>
  );
}
