import Link from 'next/link';
import Image from 'next/image';

/**
 * app/page.tsx - AI Push-Up Coach Home
 *
 * Linear-tight light landing: short copy, static product preview,
 * real held-out metrics only. No fake live numbers.
 */

const EVAL = [
  { label: 'Held-out accuracy', value: '74.6%' },
  { label: 'Bad-form recall', value: '75.6%' },
  { label: 'Test reps', value: '205' },
  { label: 'Unseen subjects', value: '4' },
] as const;

const ENTRY = [
  { href: '/workout', label: 'Workout', blurb: 'Camera, reps, form feedback.' },
  { href: '/challenge', label: '30s Challenge', blurb: 'Max valid reps in thirty seconds.' },
  { href: '/flappy', label: 'Flappy Push-Up', blurb: 'Body-controlled arcade.' },
  { href: '/about', label: 'About', blurb: 'Model card and privacy.' },
] as const;

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-16 pt-8 sm:px-6 sm:pt-14 lg:px-8 lg:pt-20">
      <section className="grid grid-cols-1 gap-9 lg:grid-cols-12 lg:items-center lg:gap-14">
        <div className="lg:col-span-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            REAL MOVEMENT. REAL FEEDBACK.
          </p>
          <h1 className="mt-4 max-w-[680px] text-[clamp(2.65rem,4vw,4rem)] font-bold leading-[1.02] tracking-[-0.055em] text-ink">
            Push-up coaching that feels real-time.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-muted sm:text-lg">
            Your camera tracks push-ups, counts reps, and analyses form with real-time feedback.
            It calibrates to your movement and processes everything locally in the browser.
          </p>
          <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row min-[420px]:flex-wrap min-[420px]:items-center">
            <Link href="/workout" className="btn-primary inline-flex min-h-12 w-full justify-center px-6 min-[420px]:w-auto">
              Start workout
            </Link>
            <Link href="/challenge" className="btn-secondary inline-flex min-h-12 w-full justify-center px-6 min-[420px]:w-auto">
              Try 30s challenge
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-muted">No account required. No video leaves your device.</p>
        </div>

        <div className="lg:col-span-6">
          <ProductPreview />
        </div>
      </section>

      <section aria-label="Product modes" className="mt-14 border-t border-base-border pt-8 sm:mt-20">
        <div className="mb-6 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
          <div>
            <p className="metric-label">Built for real progress</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-ink sm:text-3xl">Four ways to move.</h2>
          </div>
          <p className="max-w-sm text-sm text-ink-muted">Train with feedback, test your pace, or play with movement.</p>
        </div>
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-base-border bg-base-border sm:grid-cols-2 lg:grid-cols-4">
          {ENTRY.map((item) => (
            <Link key={item.href} href={item.href} className="group flex min-h-28 flex-col justify-between bg-base-raised p-5 transition-colors hover:bg-base-hover">
              <span className="text-base font-semibold text-ink transition-colors group-hover:text-accent">
                {item.label}
              </span>
              <span className="mt-3 flex items-end justify-between gap-3 text-sm text-ink-muted">{item.blurb}<span aria-hidden="true" className="text-accent">↗</span></span>
            </Link>
          ))}
        </div>
      </section>

      <section
        aria-label="Held-out evaluation"
        className="mt-12 border-t border-base-border pt-7"
      >
        <p className="metric-label">Held-out evaluation</p>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          {EVAL.map((m) => (
            <div key={m.label}>
              <div className="tabular text-2xl font-bold tracking-tight text-ink sm:text-3xl">{m.value}</div>
              <div className="mt-0.5 text-xs text-ink-muted">{m.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          RandomForestClassifier | 34 features | test subjects never seen in training.
        </p>
      </section>
    </div>
  );
}

/** An illustrative preview. Live measurements appear only after camera tracking starts. */
function ProductPreview() {
  return (
    <div className="overflow-hidden rounded-[14px] border border-base-border bg-base-raised p-2 shadow-soft sm:p-3">
      <div className="relative aspect-[5/4] overflow-hidden rounded-control bg-[#e9ecee] sm:aspect-[8/5]">
        <Image
          src="/pushup-coach-preview.png"
          alt="Athlete performing a push-up on an exercise mat"
          fill
          priority
          unoptimized
          className="object-cover object-[48%_50%]"
          sizes="(max-width: 1024px) 100vw, 55vw"
        />
        <div className="absolute left-3 top-3 rounded-full bg-ink/75 px-3 py-1.5 text-xs font-medium text-white sm:left-4 sm:top-4">
          Movement preview
        </div>
        <div className="absolute bottom-3 left-3 rounded-full bg-ink/75 px-3 py-1.5 text-xs text-white sm:bottom-4 sm:left-4">
          Your camera becomes the coach
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 px-2 py-3 text-center sm:gap-3 sm:px-3">
        <div><span className="block text-sm font-semibold text-ink">Track</span><span className="text-[11px] text-ink-muted">On device</span></div>
        <div className="border-x border-base-border"><span className="block text-sm font-semibold text-ink">Count</span><span className="text-[11px] text-ink-muted">Every rep</span></div>
        <div><span className="block text-sm font-semibold text-ink">Improve</span><span className="text-[11px] text-ink-muted">With feedback</span></div>
      </div>
    </div>
  );
}
