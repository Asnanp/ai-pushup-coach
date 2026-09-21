import Link from 'next/link';

/**
 * components/AppFooter.tsx
 *
 * Minimalist footer with quiet links and on-device privacy note.
 */
export function AppFooter() {
  return (
    <footer className="mt-20 border-t border-base-border py-10 text-xs text-ink-muted">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-bold text-ink">AI Push-Up Coach.</span>
          <span className="mx-2 text-ink-faint">·</span>
          <span>100% on-device vision. Zero camera frames leave your device.</span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-6">
          <Link href="/tips" className="hover:text-ink transition-colors">
            Form Tips
          </Link>
          <Link href="/challenge" className="hover:text-ink transition-colors">
            30s Challenge
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
