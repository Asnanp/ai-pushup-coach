'use client';

/**
 * components/AppHeader.tsx
 *
 * Agent 4 — FRONTEND SHELL ENGINEER
 *
 * Top navigation, matching the reference layout: logo mark + wordmark +
 * tagline on the left, nav links centre-right, profile chip far right.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Logo } from './Logo';

const NAV = [
  { href: '/workout', label: 'Workout' },
  { href: '/progress', label: 'Progress' },
  { href: '/tips', label: 'Tips' },
  { href: '/about', label: 'About' },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-base-border bg-base">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-5">
        {/* Brand */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-3 rounded-control focus-visible:ring-2"
          aria-label="AI Push-Up Coach — home"
        >
          <Logo className="h-8 w-8" />
          <span className="flex flex-col leading-tight">
            <span className="text-[15px] font-semibold tracking-tight text-ink">
              AI Push-Up Coach
            </span>
            <span className="text-[11px] text-ink-muted">Better form. A stronger you.</span>
          </span>
        </Link>

        <div className="flex-1" />

        {/* Nav */}
        <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'relative rounded-control px-3 py-2 text-sm transition-colors',
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {item.label}
                {active && (
                  <span
                    className="absolute inset-x-3 -bottom-[1px] h-[2px] rounded-full bg-accent"
                    aria-hidden="true"
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Profile */}
        <div className="ml-2 flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full border border-base-border bg-base-raised text-xs font-semibold text-ink-muted"
            aria-label="Local profile"
            title="Sessions are stored locally on this device"
          >
            R
          </div>
        </div>
      </div>
    </header>
  );
}

