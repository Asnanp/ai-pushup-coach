import Link from 'next/link';

/**
 * app/page.tsx — AI Push-Up Coach Home.
 *
 * Swiss Architectural / Editorial Minimalism:
 * Directly inspired by the reference design:
 * - Asymmetric split hero (bold typography on left, description & pill CTA on right)
 * - Fine hairline rules and architectural numbered indexes
 * - Quiet, uncluttered functional cards
 */
export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
      {/* Hero Section: Asymmetric Editorial Split */}
      <section className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:items-end">
        {/* Left Column (7 cols): Massive confident headline */}
        <div className="lg:col-span-7">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-base-border bg-base-raised px-3 py-1 text-xs text-ink-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            <span>On-device computer vision · No registration</span>
          </div>

          <h1 className="text-5xl font-extrabold tracking-tight text-ink sm:text-7xl lg:text-8xl leading-[0.98]">
            Minimalism<br />
            in motion.
          </h1>

          <p className="mt-6 font-mono text-xs uppercase tracking-widest text-ink-faint">
            // Biomechanical Analysis &amp; Rep Counting
          </p>
        </div>

        {/* Right Column (5 cols): Description + Pill CTA */}
        <div className="flex flex-col items-start gap-6 lg:col-span-5 lg:pb-3">
          <p className="text-base leading-relaxed text-ink-muted sm:text-lg">
            Real-time push-up coaching running directly in your browser.
            Measures your elbow excursion, checks chest depth, and provides
            instant spoken feedback with zero video uploads.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/workout"
              className="inline-flex items-center gap-2 rounded-full border border-ink bg-ink px-7 py-3 text-xs font-semibold uppercase tracking-wider text-base transition-all hover:bg-ink/85 hover:shadow-sm"
            >
              <span>Start Workout</span>
              <span className="text-sm">↘</span>
            </Link>
            <Link
              href="/challenge"
              className="inline-flex items-center gap-2 rounded-full border border-base-border bg-base-raised px-6 py-3 text-xs font-semibold uppercase tracking-wider text-ink transition-all hover:border-ink"
            >
              <span>30s Challenge</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Editorial Exhibition Showcase */}
      <section className="mt-20 border-t border-base-border pt-12">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <span className="font-mono text-xs uppercase tracking-widest text-ink-faint">
              01 / Core Architecture
            </span>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-ink sm:text-2xl">
              Engineered for precision and quiet focus.
            </h2>
          </div>
          <div className="text-xs text-ink-muted font-mono">
            WASM 60 FPS · Local Inference
          </div>
        </div>

        {/* 3 Numbered Columns with Hairline Separation */}
        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="card p-6">
            <div className="font-mono text-xs font-semibold text-ink-faint">01.01</div>
            <h3 className="mt-3 text-base font-bold text-ink">
              Bilateral Joint Fusion
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Dynamically evaluates both left and right elbow angles. Prevents
              tracking dropouts when one arm is occluded in front-facing camera angles.
            </p>
          </div>

          <div className="card p-6">
            <div className="font-mono text-xs font-semibold text-ink-faint">01.02</div>
            <h3 className="mt-3 text-base font-bold text-ink">
              Autorange Calibration
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Learns your individual top lockout and bottom depth. Adjusts hysteresis
              dynamically so repetitions require authentic full range of motion.
            </p>
          </div>

          <div className="card p-6">
            <div className="font-mono text-xs font-semibold text-ink-faint">01.03</div>
            <h3 className="mt-3 text-base font-bold text-ink">
              Zero Video Streaming
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              All neural network computation and angle math happen on your CPU/GPU
              inside your browser tab. No camera frames ever leave your device.
            </p>
          </div>
        </div>
      </section>

      {/* Protocol / Setup Guide */}
      <section className="mt-16 border-t border-base-border pt-12">
        <div className="mb-8">
          <span className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            02 / Setup Protocol
          </span>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-ink">
            How it works in three steps.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div className="border-l-2 border-base-border pl-5">
            <div className="font-mono text-xs text-ink-faint">STEP 01</div>
            <div className="mt-2 text-sm font-bold text-ink">Position Camera</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Place laptop or phone 2–3 meters back, roughly chest height.
              Side view offers maximum depth precision.
            </p>
          </div>

          <div className="border-l-2 border-base-border pl-5">
            <div className="font-mono text-xs text-ink-faint">STEP 02</div>
            <div className="mt-2 text-sm font-bold text-ink">Hands-Free Framing</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Get into push-up position. The vision engine confirms upper body
              framing and lighting automatically.
            </p>
          </div>

          <div className="border-l-2 border-base-border pl-5">
            <div className="font-mono text-xs text-ink-faint">STEP 03</div>
            <div className="mt-2 text-sm font-bold text-ink">Audio Countdown</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              A 3-2-1 spoken countdown starts automatically once in position.
              No need to reach over and tap your screen.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
