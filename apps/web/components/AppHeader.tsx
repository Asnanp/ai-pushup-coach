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
import { Logo } from './Logo';

const NAV = [
  { href: '/workout', label: 'Workout' },
  { href: '/challenge', label: 'Challenge' },
  { href: '/progress', label: 'Progress' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/tips', label: 'Form Tips' },
  { href: '/about', label: 'About' },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-base-border bg-base/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-4 px-5">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2.5 text-sm font-semibold text-ink"
          aria-label="AI Push-Up Coach — home"
        >
          <Logo className="h-5 w-5 text-accent" />
          <span>AI Push-Up Coach</span>
        </Link>

        {/* Navigation */}
        <nav aria-label="Main" className="hidden md:flex items-center gap-1">
          {NAV.map((item) => {
            const active =
              pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'rounded-control px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'text-ink bg-base-hover'
                    : 'text-ink-muted hover:text-ink hover:bg-base-hover/50',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Action */}
        <div className="flex items-center gap-3">
          <Link
            href="/workout"
            className="btn-primary py-1.5 px-3 text-xs"
          >
            Start Workout
          </Link>
        </div>
      </div>
    </header>
  );
}
