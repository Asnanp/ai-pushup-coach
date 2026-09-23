'use client';

/**
 * components/AppHeader.tsx
 *
 * Sticky light product header - primary product nav only.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';
import { Logo } from '@/components/Logo';

const NAV = [
  { href: '/workout', label: 'Workout', mobileLabel: 'Workout' },
  { href: '/challenge', label: '30s Challenge', mobileLabel: '30s' },
  { href: '/flappy', label: 'Flappy Push-Up', mobileLabel: 'Flappy' },
  { href: '/about', label: 'About', mobileLabel: 'About' },
];

export function AppHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const onWorkout = pathname === '/workout' || pathname.startsWith('/workout/');

  return (
    <header className="sticky top-0 z-50 border-b border-base-border bg-base-raised/95 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-14 max-w-[1320px] items-center justify-between gap-2 px-4 py-2 sm:gap-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-ink transition-opacity hover:opacity-80 sm:text-[16px]"
          aria-label="AI Push-Up Coach - home"
          onClick={() => setOpen(false)}
        >
          <Logo className="h-6 w-6 shrink-0 text-accent" />
          <span className="truncate sm:whitespace-nowrap">
            <span className="hidden sm:inline">AI </span>Push-Up Coach
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-6 lg:flex">
          {NAV.map((item) => {
            const active =
              pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'relative pb-0.5 text-sm font-medium transition-colors',
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {item.label}
                {active && (
                  <span
                    className="absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {!onWorkout && (
            <Link href="/workout" className="btn-primary inline-flex min-h-10 px-3 py-1.5 text-xs sm:px-4 sm:text-sm">
              <span className="sm:hidden">Start</span><span className="hidden sm:inline">Start Workout</span>
            </Link>
          )}
          <button
            type="button"
            className="btn-secondary min-h-10 px-3 py-1.5 text-xs lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Mobile"
          className="border-t border-base-border bg-base-raised px-4 py-3 lg:hidden"
        >
          <div className="mx-auto grid max-w-[1320px] grid-cols-2 gap-2 sm:grid-cols-4">
            {NAV.map((item) => {
              const active =
                pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={clsx(
                    'rounded-control border px-3 py-2.5 text-center text-xs font-medium',
                    active
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-base-border text-ink-muted hover:text-ink',
                  )}
                >
                  {item.mobileLabel}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </header>
  );
}
