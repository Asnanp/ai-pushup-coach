import Link from 'next/link';

/**
 * components/AppFooter.tsx
 *
 * Athletic AI Motion Lab footer: brand mark with status beacon,
 * high-tech on-device privacy guarantee, and utility navigation.
 */
export function AppFooter() {
  return (
    <footer className="mt-16 border-t border-white/[0.07] bg-base-card/40 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-5 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent shadow-glow-sm animate-pulse" />
            <span className="font-display text-sm font-bold tracking-wider text-white">
              AI PUSH-UP COACH <span className="text-cyan text-xs">V2</span>
            </span>
          </div>
          <p className="text-xs text-ink-muted">
            Next-generation real-time biomechanics & motion intelligence.
          </p>
        </div>

        {/* Tech Badges */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/[0.06] px-2.5 py-1 text-[10px] font-mono font-medium text-accent">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            100% ON-DEVICE PRIVACY
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan/20 bg-cyan/[0.06] px-2.5 py-1 text-[10px] font-mono font-medium text-cyan">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            WASM 60 FPS
          </span>
        </div>

        {/* Navigation */}
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/tips" className="text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
            Biometrics & Tips
          </Link>
          <Link href="/about#privacy" className="text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
            Privacy Policy
          </Link>
          <Link href="/about" className="text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
            About Lab
          </Link>
          <Link href="/about#contact" className="text-xs font-medium text-ink-muted transition-colors hover:text-cyan">
            Contact
          </Link>
        </nav>
      </div>
    </footer>
  );
}
