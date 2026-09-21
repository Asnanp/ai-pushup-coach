/**
 * app/tips/page.tsx
 *
 * Form tips, grounded in what the pipeline actually measures.
 *
 * All fault names are imported from `ISSUE_COPY` (packages/form-engine/src/feedback.ts).
 * Static server component.
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
    note: 'Deepest elbow bend of the rep. 90° scores 100; stopping short at 125° scores ~64; never bending scores 0.',
  },
  {
    name: 'Alignment',
    weight: '0.30',
    metric: 'body_line_deviation_max_abs',
    note: 'Deviation of hips from shoulder-to-ankle line (torso lengths). Small deviations under 0.05 are treated as perfect.',
  },
  {
    name: 'Tempo',
    weight: '0.20',
    metric: 'rep_duration_s, descent_s, ascent_s',
    note: 'Cadence and symmetry. 1.2s to 4.0s per rep scores full marks; catches uncontrolled dropping.',
  },
  {
    name: 'Consistency',
    weight: '0.10',
    metric: 'elbow angular velocity, jitter_score',
    note: 'Stability of movement — smooth joint travel through both descent and push phases.',
  },
  {
    name: 'Range of motion',
    weight: '0.10',
    metric: 'rom_elbow_deg',
    note: 'Total elbow travel across the rep. 70°+ gives full marks; guards against shallow pulsing.',
  },
];

// ---------------------------------------------------------------------------
// Faults
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
    <div className="mx-auto max-w-[1000px] px-5 py-10">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-base-border pb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Form Tips & Biomechanics
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            The mathematical thresholds and kinematic rules evaluated by the on-device coach.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Link href="/workout" className="btn-primary">
            Start Workout
          </Link>
          <Link href="/challenge" className="btn-secondary">
            Challenge
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Scoring components                                               */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Scoring Components
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          Scored 0–100 from measured 33-point landmarks. Geometry represents 65% of the score and the trained classifier 35%.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COMPONENTS.map((c) => (
            <div key={c.name} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">{c.name}</h3>
                <span className="font-mono text-xs text-accent">
                  weight {c.weight}
                </span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-ink-faint">
                {c.metric}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">{c.note}</p>
            </div>
          ))}

          {/* Model Card */}
          <div className="card p-4 border-cyan/30">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">ML Classifier</h3>
              <span className="font-mono text-xs text-cyan">weight 0.35</span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-faint">
              P(good form)
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Gradient-boosted ensemble trained on 917 reps across 24 people. Evaluated on held-out subjects.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Faults list                                                      */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Fault Detectors & Corrections
        </h2>
        <p className="mt-1 text-xs text-ink-faint">
          Faults are reported only when the corresponding geometric trigger is directly violated.
        </p>

        <div className="mt-4 space-y-3">
          {RANKED_TIPS.map((tip, idx) => {
            const copy = ISSUE_COPY[tip.code];
            return (
              <div key={tip.code} className="card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-ink-faint">#{idx + 1}</span>
                    <h3 className="text-sm font-semibold text-ink">{copy.headline}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {tip.captureQuality ? (
                      <span className="rounded bg-warn/10 px-2 py-0.5 text-[10px] text-warn">
                        Camera Framing
                      </span>
                    ) : (
                      <span className="rounded bg-base px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                        Importance: {tip.importance.toFixed(3)}
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-ink-faint">{tip.code}</span>
                  </div>
                </div>

                <p className="mt-2 text-xs text-ink-muted">{copy.detail}</p>

                <div className="mt-2.5 rounded bg-base p-2.5 text-xs">
                  <span className="font-medium text-accent">Correction: </span>
                  <span className="text-ink">{copy.tip}</span>
                </div>

                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-ink-faint">
                  <div>
                    <span>Metric: </span>
                    <span className="font-mono text-ink-muted">{tip.metric}</span>
                  </div>
                  <div>
                    <span>Trigger: </span>
                    <span className="text-ink-muted">{tip.trigger}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Camera Setup                                                     */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Camera Placement
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="card p-4 border-accent/40">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Side View</h3>
              <span className="text-[10px] font-semibold text-accent uppercase">Recommended</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Clearest profile for measuring elbow flexion and body alignment without perspective foreshortening.
            </p>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Diagonal 45°</h3>
              <span className="text-[10px] text-ink-muted uppercase">Secondary</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Balanced hybrid profile. Best for detecting shoulder abduction / elbow flare.
            </p>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Front View</h3>
              <span className="text-[10px] text-ink-muted uppercase">Supported</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              Uses bilateral elbow tracking and grounded plank projection when feet are occluded along the Z-axis.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
