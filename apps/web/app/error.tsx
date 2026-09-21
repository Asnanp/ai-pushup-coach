'use client';

/**
 * app/error.tsx
 *
 * Agent 6 — WEB PLATFORM ENGINEER
 *
 * Route-level error boundary for the App Router. Must be a client component:
 * `reset` is a function prop and the boundary is re-rendered on the client.
 *
 * What is shown to the user is deliberately narrow. `error.message` and the
 * stack are NOT rendered — a raw exception message can leak internals and is
 * meaningless to a visitor at a demo booth. `error.digest` is the only
 * identifier surfaced, because Next.js generates it server-side and it is safe
 * to quote when matching a report to a server log.
 */

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Full detail stays in the console for whoever is debugging; the UI shows
    // only the digest.
    console.error('Unhandled error in app route', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-16">
      <div className="mx-auto max-w-xl">
        <p className="text-label uppercase text-ink-muted">Application error</p>

        <h1 className="mt-3 text-display font-semibold tracking-tight text-ink">
          This page could not be displayed
        </h1>

        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
          Something failed while rendering this page. Your saved sessions are stored on this device
          and are not affected by this error.
        </p>

        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
          Trying again reloads this page and re-runs its data. If it keeps failing, return to the
          home page and start from there.
        </p>

        {error.digest ? (
          <div className="card mt-6 px-4 py-3">
            <p className="text-xs leading-relaxed text-ink-muted">
              Reference code:{' '}
              <span className="font-mono tabular text-ink" translate="no">
                {error.digest}
              </span>
            </p>
          </div>
        ) : null}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          {/* A plain anchor, not next/link: a hard navigation is the reliable
              way out of a broken client-side render. */}
          <a href="/" className="btn-secondary">
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
