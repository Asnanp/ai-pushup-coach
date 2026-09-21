import Link from 'next/link';

/**
 * components/AppFooter.tsx
 *
 * Matches the reference's quiet footer: small wordmark + tagline on the left,
 * utility links on the right.
 */
export function AppFooter() {
  return (
    <footer className="mt-10 border-t border-base-border">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-6 sm:flex-row sm:items-center">
        <div>
          <div className="text-sm font-medium text-ink">AI Push-Up Coach</div>
          <div className="text-xs text-ink-faint">Built for a stronger tomorrow.</div>
        </div>
        <div className="flex-1" />
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/about#privacy" className="text-xs text-ink-muted hover:text-ink">
            Privacy
          </Link>
          <Link href="/about" className="text-xs text-ink-muted hover:text-ink">
            About
          </Link>
          <Link href="/about#contact" className="text-xs text-ink-muted hover:text-ink">
            Contact
          </Link>
          <span className="text-xs text-ink-faint">Small efforts. Big changes.</span>
        </nav>
      </div>
    </footer>
  );
}
