'use client';

/**
 * components/AppHeader.tsx
 *
 * Minimalist header: clean brand title, simple navigation links,
 * and quick workout button.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

const NAV = [
  { href: '/workout', label: 'Workout' },
  { href: '/challenge', label: 'Challenge' },
  { href: '/flappy', label: 'Flappy Push-Up 🎮' },
  { href: '/progress', label: 'Progress' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/tips', label: 'Form Tips' },
  { href: '/about', label: 'About' },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-base-border bg-base/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2 text-base font-bold tracking-tight text-ink transition-opacity hover:opacity-80"
          aria-label="AI Push-Up Coach — home"
        >
          <span>AI Push-Up Coach<span className="text-emerald-600">.</span></span>
        </Link>

        {/* Navigation */}
        <nav aria-label="Main" className="hidden md:flex items-center gap-6">
          {NAV.map((item) => {
            const active =
              pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'text-xs tracking-normal transition-colors font-medium',
                  active
                    ? 'text-ink font-semibold border-b border-ink pb-0.5'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Action: Pill outline button matching reference */}
        <div className="flex items-center gap-3">
          <Link
            href="/workout"
            className="rounded-full border border-ink/80 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-ink transition-all hover:bg-ink hover:text-base"
          >
            Start Workout ↗
          </Link>
        </div>
      </div>
    </header>
  );
}
