'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * components/AppFooter.tsx
 *
 * Slim footer. Hidden on live training routes.
 */
export function AppFooter() {
  const pathname = usePathname();
  if (pathname.startsWith('/workout') || pathname.startsWith('/challenge')) {
    return null;
  }

  return (
    <footer className="mt-12 border-t border-base-border py-6 text-xs text-ink-muted pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <span className="font-semibold text-ink">AI Push-Up Coach.</span>
          <span className="mx-2 text-ink-faint" aria-hidden>
            |
          </span>
          <span>No video leaves your device.</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-4">
          <Link href="/challenge" className="transition-colors hover:text-ink">
            30s Challenge
          </Link>
          <Link href="/about" className="transition-colors hover:text-ink">
            About
          </Link>
          <Link href="/about#privacy" className="transition-colors hover:text-ink">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}