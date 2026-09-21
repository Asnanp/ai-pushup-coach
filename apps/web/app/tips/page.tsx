/**
 * app/tips/page.tsx
 *
 * Form tips, grounded in what the pipeline actually measures.
 *
 * Two rules drive this page:
 *  1. Every fault name here is imported from `ISSUE_COPY`
 *     (`packages/form-engine/src/feedback.ts`) — the same table the live
 *     feedback panel reads.
 *  2. Every trigger threshold and accuracy metric is from the engine and trained model.
 *
 * Server component: static content and fault table constant.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { IssueCode } from '@ai-pushup-coach/types';
import { ISSUE_COPY } from '@ai-pushup-coach/form-engine';

export const metadata: Metadata = {
  title: 'Form tips — AI Push-Up Coach',
  description:
    'What a good push-up looks like, which measurements the coach actually takes, how to set up the camera, and how much to trust the form score.',
};

// ---------------------------------------------------------------------------
// What the rep score is made of
// ---------------------------------------------------------------------------

interface Component {
  name: string;
  weight: string;
  metric: string;
  note: string;
}

const COMPONENTS: Component[] = [
  {
    name: 'Depth',
    weight: '0.30',
    metric: 'min_elbow_angle_deg',
    note: 'The deepest elbow bend of the rep. 90° scores 100; stopping at 125° scores ~64; never bending at all scores 0.',
  },
  {
    name: 'Alignment',
    weight: '0.30',
    metric: 'body_line_deviation_max_abs',
    note: 'Deviation of hips from shoulder-to-ankle line (torso lengths). Deviations under 0.05 are treated as perfect. At 0.18 it scores 0.',
  },
  {
    name: 'Tempo',
    weight: '0.20',
    metric: 'rep_duration_s, descent_s, ascent_s',
    note: 'Cadence and symmetry. 1.2s to 4.0s per rep scores full marks; catches reps that dive down with uncontrolled eccentric drop.',
  },
  {
    name: 'Consistency',
    weight: '0.10',
    metric: 'elbow angular velocity spread, jitter_score',
    note: 'Stability of the movement — how evenly and smoothly the joints travel throughout the eccentric and concentric phases.',
  },
  {
    name: 'Range of motion',
    weight: '0.10',
    metric: 'rom_elbow_deg',
    note: 'Total elbow travel across the rep. 70°+ gives full marks; prevents partial reps from falsely tripping the rep counter.',
  },
];

// ---------------------------------------------------------------------------
// Faults. Headlines, details and fixes come from ISSUE_COPY verbatim.
// ---------------------------------------------------------------------------

interface Tip {
  code: IssueCode;
  metric: string;
  trigger: string;
  importance: number;
  captureQuality?: boolean;
}

const TIPS: Tip[] = [
  {
    code: 'TOO_FAST',
    metric: 'rep_duration_s',
    trigger: 'rep completed in under 0.9 s',
    importance: 0.160,
  },
  {
    code: 'HIPS_DROPPING',
    metric: 'body_line_deviation_mean',
    trigger: 'hips more than 0.10 torso-lengths below shoulder-ankle line',
    importance: 0.105,
  },
  {
    code: 'HIPS_TOO_HIGH',
    metric: 'body_line_deviation_mean',
    trigger: 'hips more than 0.10 torso-lengths above shoulder-ankle line',
    importance: 0.105,
  },
  {
    code: 'INCOMPLETE_DEPTH',
    metric: 'min_elbow_angle_deg',
    trigger: 'deepest elbow angle above 105°',
    importance: 0.046,
  },
  {
    code: 'BODY_NOT_STRAIGHT',
    metric: 'body_line_deviation_range',
    trigger: 'body line varied by more than 0.15 torso-lengths during rep',
    importance: 0.034,
  },
  {
    code: 'KNEES_BENT',
    metric: 'knee_angle_deg_mean',
    trigger: 'average knee angle below 150°',
    importance: 0.033,
  },
  {
    code: 'ELBOW_FLARE',
    metric: 'shoulder_angle_deg_mean',
    trigger: 'shoulder abduction above 75°, front/diagonal view only',
    importance: 0.020,
  },
  {
    code: 'PARTIAL_RANGE',
    metric: 'rom_elbow_deg',
    trigger: 'elbow travel under 30°',
    importance: 0.009,
  },
  {
    code: 'UNSTABLE',
    metric: 'jitter_score',
    trigger: 'landmark jitter above 0.02',
    importance: 0,
  },
  {
    code: 'LOW_CONFIDENCE',
    metric: 'mean_visibility, tracking_gap_ratio',
    trigger: 'active-side visibility below 0.5',
    importance: 0,
    captureQuality: true,
  },
];

const ENGINE_PRIORITY: IssueCode[] = [
  'INCOMPLETE_DEPTH',
  'HIPS_DROPPING',
  'HIPS_TOO_HIGH',
  'BODY_NOT_STRAIGHT',
  'KNEES_BENT',
  'ELBOW_FLARE',
  'PARTIAL_RANGE',
  'TOO_FAST',
  'UNSTABLE',
];

function engineRank(code: IssueCode): number {
  const i = ENGINE_PRIORITY.indexOf(code);
  return i === -1 ? 99 : i;
}

const RANKED_TIPS = [...TIPS].sort(
  (a, b) => b.importance - a.importance || engineRank(a.code) - engineRank(b.code),
);

// ---------------------------------------------------------------------------

export default function TipsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-white/[0.06] pb-8">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/[0.07] px-3 py-1 text-xs font-mono font-medium text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            AI BIOMECHANICS LAB · FORM PROTOCOLS
          </div>
          <h1 className="mt-3 font-display text-4xl font-extrabold uppercase tracking-tight text-white sm:text-5xl">
            Push-Up Biomechanics Standards
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Engineered against real anatomical kinematics. Every threshold and trigger below is the
            exact mathematical rule evaluated by the on-device AI during your workout.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/workout" className="btn-primary">
            Start Live Coach
          </Link>
          <Link href="/progress" className="btn-secondary">
            View Analytics
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* What the score is made of                                        */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-12">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-glow-sm" />
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">
            The Five Geometric Biomechanics Pillars
          </h2>
        </div>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-muted">
          Each component is scored 0–100 from measured 33-point body keypoints, then weighted into
          the overall score. Geometry comprises 65% of the rep score, and the calibrated gradient-boosted
          classifier contributes the remaining 35%.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {COMPONENTS.map((c) => (
            <div
              key={c.name}
              className="glass-card relative overflow-hidden rounded-2xl border border-white/[0.06] p-5 transition-all hover:border-white/[0.12]"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                  {c.name}
                </h3>
                <span className="rounded-full border border-accent/20 bg-accent/10 px-2.5 py-0.5 font-mono text-xs font-semibold text-accent">
                  weight {c.weight}
                </span>
              </div>
              <div className="mt-3 rounded-lg border border-white/[0.04] bg-base-darker/60 px-3 py-2">
                <span className="font-mono text-[11px] text-cyan break-words">
                  {c.metric}
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">{c.note}</p>
            </div>
          ))}

          {/* Model Score Card */}
          <div className="glass-card relative overflow-hidden rounded-2xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.04] to-transparent p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                ML Classifier Score
              </h3>
              <span className="rounded-full border border-cyan/30 bg-cyan/10 px-2.5 py-0.5 font-mono text-xs font-semibold text-cyan">
                weight 0.35
              </span>
            </div>
            <div className="mt-3 rounded-lg border border-cyan/10 bg-base-darker/60 px-3 py-2">
              <span className="font-mono text-[11px] text-cyan break-words">
                P(good), calibrated ensemble output
              </span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              Probabilistic biomechanics validation. Catches nonlinear subtleties that explicit
              rules miss. If offline or uncalibrated, falls back gracefully to pure geometry.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Faults and their detectors                                       */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-14">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-danger shadow-glow-sm" />
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">
            Form Fault Detectors & Corrective Cues
          </h2>
        </div>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-muted">
          Ranked by pooled feature importance from the machine learning model. A fault is reported
          only when its geometric trigger condition is objectively violated in real-time telemetry.
        </p>

        <div className="mt-6 space-y-4">
          {RANKED_TIPS.map((tip, idx) => {
            const copy = ISSUE_COPY[tip.code];
            const rankStr = String(idx + 1).padStart(2, '0');
            return (
              <div
                key={tip.code}
                className="glass-card relative rounded-2xl border border-white/[0.06] p-5 transition-all hover:border-white/[0.14]"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="font-display text-xl font-black text-ink-faint">
                      #{rankStr}
                    </span>
                    <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                      {copy.headline}
                    </h3>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {tip.captureQuality ? (
                      <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-amber-400">
                        CAMERA QUALITY ISSUE
                      </span>
                    ) : (
                      <span className="rounded-full border border-cyan/20 bg-cyan/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-cyan">
                        IMPORTANCE {tip.importance.toFixed(3)}
                      </span>
                    )}
                    <span className="rounded-md border border-white/[0.08] bg-base-darker px-2 py-0.5 font-mono text-[11px] text-ink-faint">
                      {tip.code}
                    </span>
                  </div>
                </div>

                <p className="mt-3 text-xs leading-relaxed text-ink-muted">{copy.detail}</p>

                {/* Fix Callout */}
                <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-accent/20 bg-accent/[0.04] p-3">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] font-black text-accent">
                    ✓
                  </span>
                  <p className="text-xs leading-relaxed text-white">
                    <strong className="text-accent font-semibold">CORRECTION: </strong>
                    {copy.tip}
                  </p>
                </div>

                {/* Telemetry trigger grid */}
                <div className="mt-4 grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-base-darker/50 p-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      Measured Telemetry Metric
                    </span>
                    <p className="mt-0.5 break-words font-mono text-[11px] font-medium text-cyan">
                      {tip.metric}
                    </p>
                  </div>
                  <div className="rounded-lg bg-base-darker/50 p-2.5">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                      Active Trigger Boundary
                    </span>
                    <p className="mt-0.5 font-mono text-[11px] text-white">
                      {tip.trigger}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Camera setup                                                     */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-14">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent shadow-glow-sm" />
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">
            Camera Placement & Optical Setup
          </h2>
        </div>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-muted">
          Accurate biomechanics require crisp, unobstructed joint lines. The calibration phase
          validates framing, lighting, and viewing angle before any repetition is counted.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Side View */}
          <div className="glass-card relative flex flex-col justify-between rounded-2xl border-2 border-accent/40 bg-gradient-to-b from-accent/[0.04] to-transparent p-5">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                  Side Profile View
                </h3>
                <span className="rounded-full bg-accent px-2.5 py-0.5 font-mono text-[10px] font-black uppercase text-base-darker">
                  Recommended
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Side view (0.55+ side dominance) provides the clearest trajectory for depth (elbow
                angle) and spine/hip alignment without angle foreshortening. 80% of our primary
                geometric weights rely on this profile.
              </p>
            </div>
            <div className="mt-4 rounded-xl border border-accent/20 bg-base-darker/60 p-3">
              <div className="font-mono text-[11px] font-semibold text-accent">
                BEST FOR: Depth & Spine Rigidity
              </div>
            </div>
          </div>

          {/* Diagonal View */}
          <div className="glass-card relative flex flex-col justify-between rounded-2xl border border-cyan/30 bg-gradient-to-b from-cyan/[0.03] to-transparent p-5">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                  Diagonal 45° View
                </h3>
                <span className="rounded-full border border-cyan/40 bg-cyan/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-cyan">
                  Secondary
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Provides a balanced hybrid profile. Critical for detecting shoulder flare and elbow
                abduction while still measuring depth and body line with high model confidence.
              </p>
            </div>
            <div className="mt-4 rounded-xl border border-cyan/20 bg-base-darker/60 p-3">
              <div className="font-mono text-[11px] font-semibold text-cyan">
                BEST FOR: Elbow Flare Detection
              </div>
            </div>
          </div>

          {/* Front View */}
          <div className="glass-card relative flex flex-col justify-between rounded-2xl border border-white/[0.08] p-5">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
                  Frontal View
                </h3>
                <span className="rounded-full border border-white/20 bg-white/5 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-ink-faint">
                  Fallback
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-muted">
                Hand width and shoulder abduction are clear, but torso alignment and depth are
                optically foreshortened along the camera axis. Use when room geometry prevents side view.
              </p>
            </div>
            <div className="mt-4 rounded-xl border border-white/10 bg-base-darker/60 p-3">
              <div className="font-mono text-[11px] font-semibold text-ink-muted">
                NOTE: Perspective compression applies
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* What the score means                                             */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-14">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-glow-sm" />
          <h2 className="font-display text-lg font-bold uppercase tracking-wider text-white">
            Evaluation Accuracy & Model Statistics
          </h2>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="glass-card rounded-2xl border border-white/[0.06] p-5">
            <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
              Formula Execution
            </h3>
            <div className="mt-3 rounded-xl border border-cyan/20 bg-base-darker/80 p-4 font-mono text-xs text-cyan">
              rep_score = 0.65 × geometry + 0.35 × model
            </div>
            <ul className="mt-4 space-y-2.5 text-xs leading-relaxed text-ink-muted">
              <li>
                <strong className="text-white">Validation Gate:</strong> A rep is certified valid only when P(good) ≥ 0.58 and geometry score ≥ 55.
              </li>
              <li>
                <strong className="text-white">Full Transparency:</strong> Invalid reps are highlighted with specific fault badges, never silently ignored.
              </li>
              <li>
                <strong className="text-white">Provisional Tag:</strong> Sessions with fewer than 3 reps are flagged as provisional for statistically valid sampling.
              </li>
            </ul>
          </div>

          <div className="glass-card rounded-2xl border border-white/[0.06] p-5">
            <h3 className="font-display text-base font-bold uppercase tracking-wide text-white">
              Model Benchmark On Unseen Subjects
            </h3>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Trained on 917 reps from 24 people. Evaluated strictly on 4 unseen subjects in held-out
              splits.
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <Stat term="Test Accuracy" value="0.688" />
              <Stat term="Macro F1" value="0.672" />
              <Stat term="ROC AUC" value="0.702" />
              <Stat term="Bad-Form Recall" value="0.585" />
            </dl>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="mt-14">
        <div className="glass-card flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-accent/30 bg-gradient-to-r from-accent/[0.06] via-transparent to-cyan/[0.06] p-6">
          <div>
            <h2 className="font-display text-xl font-bold uppercase tracking-tight text-white">
              Ready to Test Your Form?
            </h2>
            <p className="mt-1 text-xs text-ink-muted">
              Position your camera and begin real-time on-device biomechanical coaching now.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/workout" className="btn-primary">
              Launch Workout Session
            </Link>
            <Link href="/challenge" className="btn-secondary">
              Take 30s Challenge
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Stat({ term, value }: { term: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-base-darker/60 p-3">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">{term}</dt>
      <dd className="font-display mt-1 text-2xl font-black tracking-tight text-white">{value}</dd>
    </div>
  );
}
