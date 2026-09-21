import Link from 'next/link';
import { Logo } from '@/components/Logo';

/**
 * app/page.tsx — AI Push-Up Coach V2 Home / Showcase.
 *
 * Professional athletic biomechanics lab UI:
 * - High-impact athletic typography & vibrant cyber-emerald/laser-cyan accents
 * - Interactive simulated telemetry HUD card demonstrating live skeleton tracking
 * - Scientific breakdown of the 37 kinematic features and geometric state machine
 * - Zero marketing fluff; grounded entirely in the real on-device vision pipeline
 */
export default function HomePage() {
  return (
    <div className="relative overflow-hidden">
      {/* Ambient background glow accents */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-accent/[0.04] blur-[120px]" />
      <div className="pointer-events-none absolute top-[600px] -left-40 h-[400px] w-[500px] rounded-full bg-cyan/[0.03] blur-[100px]" />

      <div className="mx-auto max-w-[1400px] px-5 py-8 sm:py-12">
        {/* ================= HERO SECTION ================= */}
        <section className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:items-center">
          {/* Left Hero Pitch (7 cols) */}
          <div className="lg:col-span-7">
            {/* Top Pill Tag */}
            <div className="inline-flex items-center gap-2.5 rounded-full border border-accent/30 bg-accent/[0.08] px-3.5 py-1.5 shadow-sm">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="font-mono text-xs font-semibold tracking-wider text-accent uppercase">
                On-Device Pose Estimation · Zero Cloud Latency
              </span>
            </div>

            {/* Headline */}
            <h1 className="mt-6 font-display text-4xl font-extrabold uppercase tracking-tight text-ink sm:text-6xl lg:text-[4rem] leading-[1.05]">
              Real-Time AI <span className="text-accent underline decoration-accent/40 decoration-4 underline-offset-8">Push-Up</span> Lab.
            </h1>

            {/* Subheading */}
            <p className="mt-5 max-w-xl text-base sm:text-lg leading-relaxed text-ink-muted">
              Place your laptop in front or to the side. Our computer vision engine tracks your joint angles at 60 FPS,
              calibrates to your personal range of motion, counts every rep, and corrects your form with live spoken audio.
            </p>

            {/* Primary Action Buttons */}
            <div className="mt-8 flex flex-wrap items-center gap-3.5">
              <Link
                href="/workout"
                className="btn-primary py-3 px-6 text-sm font-bold uppercase tracking-wider shadow-glow hover:scale-[1.02] active:scale-[0.98]"
              >
                <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Launch Workout Set
              </Link>

              <Link
                href="/challenge"
                className="btn-secondary py-3 px-5 text-sm font-semibold hover:border-accent/40 hover:bg-base-hover"
              >
                <svg
                  className="h-4 w-4 text-warn"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
                  <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
                  <path d="M4 22h16" />
                  <path d="M10 14.66V17c0 .55-.45 1-1 1H7" />
                  <path d="M14 14.66V17c0 .55.45 1 1 1h2" />
                  <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
                </svg>
                30s Challenge
              </Link>

              <Link
                href="/tips"
                className="btn-ghost py-3 px-4 text-xs font-medium text-ink-muted hover:text-ink"
              >
                Biomechanics & Form Tips →
              </Link>
            </div>

            {/* Security / Privacy Trust Guarantee */}
            <div className="mt-7 flex flex-wrap items-center gap-4 text-xs text-ink-faint">
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                100% Private (No video leaves device)
              </span>
              <span className="text-base-border">·</span>
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                WASM Hardware Acceleration
              </span>
              <span className="text-base-border">·</span>
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
                Front & Side Camera Auto-Detection
              </span>
            </div>
          </div>

          {/* Right Hero: Simulated Live Biomechanics HUD Showcase (5 cols) */}
          <div className="lg:col-span-5">
            <div className="relative rounded-card border border-base-border/90 bg-base-raised/95 p-5 shadow-2xl backdrop-blur-xl hud-bracket">
              {/* Top Viewfinder Bar */}
              <div className="flex items-center justify-between border-b border-base-border/70 pb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-accent animate-pulse-dot" />
                  <span className="font-mono text-xs font-bold tracking-wider text-ink">
                    LIVE HUD · FRONT/SIDE VIEW
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="chip-cyan text-[10px] py-0.5 px-2">60.0 FPS</span>
                  <span className="chip-good text-[10px] py-0.5 px-2">LOCKED</span>
                </div>
              </div>

              {/* Simulated Skeleton & Angle Arc View */}
              <div className="relative mt-3 h-52 w-full overflow-hidden rounded-control bg-base-sunken border border-base-border/60">
                {/* Visual Grid Lines */}
                <div className="absolute inset-0 bg-grid opacity-30" />

                {/* 90° Target Depth Guideline */}
                <div className="absolute top-[62%] left-0 right-0 border-b border-dashed border-accent/60 flex items-center justify-between px-3">
                  <span className="text-[10px] font-mono font-semibold text-accent bg-base-sunken/80 px-1 rounded">
                    90° CHEST-TO-DECK TARGET
                  </span>
                  <span className="text-[10px] font-mono text-accent">DEPTH ✓</span>
                </div>

                {/* SVG Skeleton Simulation */}
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 360 200" fill="none">
                  {/* Ground Plane Contact Line */}
                  <line x1="20" y1="175" x2="340" y2="175" stroke="#1E2B38" strokeWidth="2" strokeDasharray="4 4" />

                  {/* Body Line (Shoulder -> Hip -> Ankle) */}
                  <line x1="100" y1="95" x2="220" y2="115" stroke="rgba(0, 240, 144, 0.9)" strokeWidth="3.5" strokeLinecap="round" />
                  <line x1="220" y1="115" x2="320" y2="170" stroke="rgba(0, 240, 144, 0.9)" strokeWidth="3.5" strokeLinecap="round" />

                  {/* Arm Support Line (Shoulder -> Elbow -> Wrist) */}
                  <line x1="100" y1="95" x2="70" y2="135" stroke="rgba(0, 229, 255, 0.9)" strokeWidth="3" strokeLinecap="round" />
                  <line x1="70" y1="135" x2="90" y2="175" stroke="rgba(0, 229, 255, 0.9)" strokeWidth="3" strokeLinecap="round" />

                  {/* Joint Landmark Circles */}
                  <circle cx="100" cy="95" r="5" fill="#F0F4F8" stroke="#00E5FF" strokeWidth="2" />
                  <circle cx="70" cy="135" r="6" fill="#00E5FF" stroke="#070A0E" strokeWidth="2" />
                  <circle cx="90" cy="175" r="5" fill="#00E5FF" />
                  <circle cx="220" cy="115" r="5" fill="#00F090" />
                  <circle cx="320" cy="170" r="5" fill="#00F090" />

                  {/* Head Marker */}
                  <circle cx="125" cy="80" r="10" stroke="#00E5FF" strokeWidth="2" fill="rgba(0, 229, 255, 0.15)" />

                  {/* Elbow Joint Angle Arc & Degree Numeral */}
                  <path d="M 85 125 A 18 18 0 0 0 65 148" stroke="#00F090" strokeWidth="2.5" fill="none" />
                  <text x="35" y="132" fill="#00F090" fontFamily="monospace" fontSize="13" fontWeight="bold">
                    92°
                  </text>
                  <text x="30" y="146" fill="#00F090" fontFamily="sans-serif" fontSize="9" fontWeight="bold">
                    DEPTH ✓
                  </text>
                </svg>

                {/* Simulated Telemetry Overlay Badges */}
                <div className="absolute top-2 left-2 flex gap-1.5">
                  <span className="rounded bg-base-raised/80 px-2 py-0.5 text-[10px] font-mono text-cyan border border-cyan/30">
                    ELBOW: 92.4°
                  </span>
                  <span className="rounded bg-base-raised/80 px-2 py-0.5 text-[10px] font-mono text-accent border border-accent/30">
                    PLANK: 178°
                  </span>
                </div>

                <div className="absolute bottom-2 right-2">
                  <span className="rounded bg-accent/20 px-2 py-1 text-[11px] font-mono font-bold text-accent border border-accent/40 shadow-sm">
                    REP #12 COUNTED
                  </span>
                </div>
              </div>

              {/* Bottom Telemetry Tiles */}
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-control bg-base-sunken p-2.5 border border-base-border/50">
                  <div className="text-[10px] font-semibold text-ink-muted uppercase">Form Score</div>
                  <div className="text-xl font-extrabold font-display text-accent">94 / 100</div>
                  <div className="text-[9px] font-mono text-accent/80 font-bold">ELITE FORM</div>
                </div>

                <div className="rounded-control bg-base-sunken p-2.5 border border-base-border/50">
                  <div className="text-[10px] font-semibold text-ink-muted uppercase">Valid Reps</div>
                  <div className="text-xl font-extrabold font-display text-ink">12 / 12</div>
                  <div className="text-[9px] font-mono text-cyan font-bold">100% CLEAN</div>
                </div>

                <div className="rounded-control bg-base-sunken p-2.5 border border-base-border/50">
                  <div className="text-[10px] font-semibold text-ink-muted uppercase">Mean Pace</div>
                  <div className="text-xl font-extrabold font-display text-ink">1.9s</div>
                  <div className="text-[9px] font-mono text-ink-muted">SYMMETRIC</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ================= SCIENTIFIC BIOMECHANICS MATRIX ================= */}
        <section className="mt-20">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-base-border pb-4">
            <div>
              <span className="text-xs font-mono font-bold text-accent uppercase tracking-widest">
                Scientific Kinematic Analysis
              </span>
              <h2 className="mt-1 font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
                What The Vision Pipeline Measures
              </h2>
            </div>
            <p className="max-w-md text-xs text-ink-muted">
              Every verdict is computed from real-time spatial vectors—never arbitrary guesses or hallucinated scores.
            </p>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              tag="PRIMARY DEPTH"
              title="Elbow Flexion & Chest-to-Deck"
              desc="Tracks 3D elbow angle per frame. Standard 90° flexion achieves full score, while stopping short at 120° is instantly caught as a partial rep."
              metric="Target: ≤ 90° | Lockout: ≥ 160°"
              accentColor="accent"
            />
            <FeatureCard
              tag="RIGID SPINE"
              title="Plank & Hip Plane Neutrality"
              desc="Measures pelvis deviation from the shoulder-to-ankle axis. Catches hip sag (abdominal weakness) or pike (butt too high) in torso units."
              metric="Max Deviation: < 0.05 torso len"
              accentColor="cyan"
            />
            <FeatureCard
              tag="CADENCE & TEMPO"
              title="Ascent / Descent Symmetry"
              desc="Evaluates eccentric descent and concentric push phase duration. Flags ballistic diving reps that lack muscular control and stability."
              metric="Optimal Cadence: 1.5s – 3.0s"
              accentColor="warn"
            />
            <FeatureCard
              tag="BILATERAL SYNC"
              title="Dual-Arm Bilateral Balance"
              desc="In Front view, compares left and right elbow excursion curves simultaneously to identify asymmetric compensation or shoulder tilt."
              metric="Bilateral Sync: < 10° delta"
              accentColor="cyan"
            />
            <FeatureCard
              tag="TRAVEL DISTANCE"
              title="Range of Motion (ROM)"
              desc="Requires minimum 70° total joint excursion from full lockout to the bottom of the rep. Rejects micro-pulses and stationary jitter."
              metric="Minimum ROM: ≥ 70° excursion"
              accentColor="accent"
            />
            <FeatureCard
              tag="AUDIO COACH"
              title="Adaptive Speech Feedback"
              desc="Delivers natural spoken corrective cues with cooldown anti-spam safeguards so you can focus on pushing without checking the screen."
              metric="Zero-lag local SpeechSynthesis"
              accentColor="warn"
            />
          </div>
        </section>

        {/* ================= 4-STEP WORKFLOW ================= */}
        <section className="mt-20 rounded-card border border-base-border bg-base-raised/60 p-6 sm:p-10">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-xs font-mono font-bold text-accent uppercase tracking-widest">
              Zero-Friction Workflow
            </span>
            <h2 className="mt-2 font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
              From Laptop to Reps in 15 Seconds
            </h2>
            <p className="mt-2 text-sm text-ink-muted">
              Built specifically for school IT fests, gym floors, and home workouts with automatic hands-free countdowns.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <StepItem
              step="01"
              title="Camera Alignment"
              desc="Step in frame. The view estimator automatically classifies Front, Side, or Diagonal and validates lighting and distance."
            />
            <StepItem
              step="02"
              title="Dynamic Calibration"
              desc="Perform 2 warm-up reps. The system measures your unique lockout and bottom depth thresholds rather than using a rigid template."
            />
            <StepItem
              step="03"
              title="Hands-Free Workout"
              desc="A spoken 3-2-1 countdown launches your set. The live 60fps oscilloscope plots your depth curve as reps are assessed in real time."
            />
            <StepItem
              step="04"
              title="Biomechanical Audit"
              desc="Review rep-by-rep form scores, pace analysis, and fault highlights stored securely on your local device."
            />
          </div>
        </section>

        {/* ================= BOTTOM CTA BANNER ================= */}
        <section className="mt-16 mb-6 rounded-card border border-accent/40 bg-gradient-to-r from-base-raised via-base-raised to-accent/[0.08] p-8 sm:p-12 text-center relative overflow-hidden shadow-glow-sm">
          <div className="max-w-xl mx-auto">
            <Logo className="h-10 w-10 text-accent mx-auto" />
            <h2 className="mt-4 font-display text-3xl font-extrabold uppercase tracking-tight text-ink sm:text-4xl">
              Ready to Test Your Push-Up Form?
            </h2>
            <p className="mt-2 text-sm text-ink-muted">
              No registration, no video uploads, no setup friction. Step in front of the camera and begin.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                href="/workout"
                className="btn-primary py-3 px-8 text-sm font-bold uppercase tracking-wider shadow-glow hover:scale-105"
              >
                Start Live Workout
              </Link>
              <Link
                href="/challenge"
                className="btn-secondary py-3 px-6 text-sm font-semibold"
              >
                Enter 30s Challenge
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function FeatureCard({
  tag,
  title,
  desc,
  metric,
  accentColor,
}: {
  tag: string;
  title: string;
  desc: string;
  metric: string;
  accentColor: 'accent' | 'cyan' | 'warn';
}) {
  const badgeClass =
    accentColor === 'accent'
      ? 'text-accent border-accent/30 bg-accent/10'
      : accentColor === 'cyan'
        ? 'text-cyan border-cyan/30 bg-cyan/10'
        : 'text-warn border-warn/30 bg-warn/10';

  return (
    <div className="card p-5 hover:border-white/20 transition-all">
      <div className="flex items-center justify-between">
        <span className={`rounded px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider border ${badgeClass}`}>
          {tag}
        </span>
      </div>
      <h3 className="mt-3 text-base font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{desc}</p>
      <div className="mt-4 pt-3 border-t border-base-border/70 flex items-center justify-between text-[11px] font-mono text-ink-faint">
        <span>{metric}</span>
      </div>
    </div>
  );
}

function StepItem({
  step,
  title,
  desc,
}: {
  step: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="card p-5 relative border border-base-border/70 bg-base-sunken/60">
      <div className="font-mono text-2xl font-black text-accent/80">{step}</div>
      <h3 className="mt-2 text-sm font-bold text-ink uppercase tracking-wide">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{desc}</p>
    </div>
  );
}
