'use client';

/**
 * components/AppHeader.tsx
 *
 * Top navigation: dynamic frosted glass header with brand mark,
 * active route pills, on-device AI engine status badge, and quick workout launcher.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Logo } from './Logo';

const NAV = [
  { href: '/workout', label: 'Workout' },
  { href: '/challenge', label: '30s Challenge' },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/progress', label: 'Progress' },
  { href: '/tips', label: 'Form Biomechanics' },
  { href: '/about', label: 'About' },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-base/80 backdrop-blur-xl transition-all duration-200">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-5">
        {/* Brand */}
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-3 rounded-control focus-visible:ring-2"
          aria-label="AI Push-Up Coach — home"
        >
          <div className="relative flex h-9 w-9 items-center justify-center rounded-control bg-base-raised/90 border border-white/10 shadow-sm transition-transform group-hover:scale-105">
            <Logo className="h-6 w-6 text-accent" />
            <div className="absolute inset-0 rounded-control bg-accent/10 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-display text-lg font-bold tracking-tight text-ink uppercase">
              AI Push-Up Coach <span className="text-accent text-xs font-mono lowercase">v2</span>
            </span>
            <span className="text-[10px] font-medium tracking-wide text-ink-muted">
              Real-Time Biomechanical Motion Lab
            </span>
          </div>
        </Link>

        {/* Center: Live AI Engine Status */}
        <div className="hidden xl:flex items-center gap-2 rounded-full border border-accent/30 bg-accent/[0.06] px-3.5 py-1 text-xs font-medium text-accent shadow-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="font-mono text-[11px] tracking-wider font-semibold">
            VISION ENGINE ACTIVE · 60 FPS · 100% ON-DEVICE
          </span>
        </div>

        {/* Nav Links */}
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
                  'relative rounded-control px-3 py-1.5 text-xs font-medium transition-all duration-200 cursor-pointer',
                  active
                    ? 'text-accent bg-accent/[0.08] shadow-sm font-semibold'
                    : 'text-ink-muted hover:text-ink hover:bg-base-hover/60',
                )}
              >
                {item.label}
                {active && (
                  <span
                    className="absolute inset-x-2 -bottom-[1px] h-[2px] rounded-full bg-accent shadow-glow-sm"
                    aria-hidden="true"
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-2.5">
          <Link
            href="/workout"
            className="btn-primary py-1.5 px-3.5 text-xs font-bold uppercase tracking-wider hidden sm:inline-flex"
          >
            Start Set
          </Link>

          <div
            className="flex h-8 w-8 items-center justify-center rounded-full border border-base-border bg-base-raised text-xs font-bold text-ink-muted shadow-inner"
            aria-label="Local profile"
            title="All session data is securely stored locally on this machine"
          >
            <svg
              className="h-4 w-4 text-accent/80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
        </div>
      </div>
    </header>
  );
}
