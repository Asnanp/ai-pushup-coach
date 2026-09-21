import Link from 'next/link';

/**
 * components/AppFooter.tsx
 *
 * Minimalist footer with quiet links and on-device privacy note.
 */
export function AppFooter() {
  return (
    <footer className="mt-16 border-t border-base-border py-8 text-xs text-ink-muted">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-medium text-ink">AI Push-Up Coach</span>
          <span className="mx-2 text-ink-faint">·</span>
          <span>On-device pose tracking. Camera frames never leave your browser.</span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-4">
          <Link href="/tips" className="hover:text-ink transition-colors">
            Form Tips
          </Link>
          <Link href="/about" className="hover:text-ink transition-colors">
            About
          </Link>
          <Link href="/about#privacy" className="hover:text-ink transition-colors">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
