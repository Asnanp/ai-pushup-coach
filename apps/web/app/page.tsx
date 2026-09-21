import Link from 'next/link';

/**
 * app/page.tsx — AI Push-Up Coach Home.
 *
 * Minimalist, direct, and functional:
 * - Clear headline and quick actions
 * - Focused 3-pillar breakdown (counting, form, privacy)
 * - Simple camera setup guide
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-[960px] px-5 py-12 sm:py-16">
      {/* Hero */}
      <section className="text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-base-border bg-base-raised px-3 py-1 text-xs text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span>On-device computer vision · No registration needed</span>
        </div>

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-ink sm:text-5xl">
          Real-time push-up coaching.
        </h1>

        <p className="mx-auto mt-4 max-w-xl text-base text-ink-muted sm:text-lg">
          Counts your repetitions and checks your form using your webcam.
          Runs entirely in your browser with zero video uploads.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/workout"
            className="btn-primary px-6 py-2.5 text-sm font-semibold"
          >
            Start Workout
          </Link>
          <Link
            href="/challenge"
            className="btn-secondary px-5 py-2.5 text-sm font-medium"
          >
            30s Challenge
          </Link>
          <Link
            href="/tips"
            className="btn-ghost px-4 py-2.5 text-sm"
          >
            Form Tips →
          </Link>
        </div>
      </section>

      {/* 3 Core Pillars */}
      <section className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">
            Rep Counting
          </div>
          <h2 className="mt-2 text-base font-semibold text-ink">
            Geometric state machine
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            Tracks joint angles with hysteresis and personal autorange calibration.
            Only complete reps with proper depth and lockout count.
          </p>
        </div>

        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-cyan">
            Form Feedback
          </div>
          <h2 className="mt-2 text-base font-semibold text-ink">
            Immediate corrective cues
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            Monitors chest depth, body alignment, and tempo. Delivers concise
            spoken voice cues so you can correct your form mid-set.
          </p>
        </div>

        <div className="card p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Privacy First
          </div>
          <h2 className="mt-2 text-base font-semibold text-ink">
            100% on-device
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-ink-muted">
            All pose estimation and inference runs locally on your machine.
            Camera frames are analyzed in memory and never saved or transmitted.
          </p>
        </div>
      </section>

      {/* Quick Setup Guide */}
      <section className="card mt-12 p-6 sm:p-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Quick Setup
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 text-xs leading-relaxed text-ink-muted">
          <div>
            <div className="font-semibold text-ink">1. Position your camera</div>
            <p className="mt-1">
              Place your laptop or phone roughly chest height, 2–3 meters back.
              Side view gives the most accurate depth readings.
            </p>
          </div>
          <div>
            <div className="font-semibold text-ink">2. Calibrate in view</div>
            <p className="mt-1">
              Step into frame. The coach automatically checks your distance,
              lighting, and camera angle before starting.
            </p>
          </div>
          <div>
            <div className="font-semibold text-ink">3. Hands-free start</div>
            <p className="mt-1">
              Get into push-up position. Once framed, a 3-2-1 voice countdown
              starts automatically—no need to touch your device.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
