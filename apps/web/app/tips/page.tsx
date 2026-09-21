/**
 * app/tips/page.tsx
 *
 * Agent 8 — FRONTEND PAGE ENGINEER
 *
 * Form tips, grounded in what the pipeline actually measures.
 *
 * Two rules drive this page:
 *
 *  1. Every fault name here is imported from `ISSUE_COPY`
 *     (`packages/form-engine/src/feedback.ts`) — the same table the live
 *     feedback panel reads. If the copy changes there, this page changes with
 *     it. Nothing is retyped, so the Tips page and the workout screen cannot
 *     drift apart.
 *  2. Every trigger threshold and every accuracy number is taken from the
 *     engine and from the trained model's own report. The classifier is a
 *     binary good/bad model with 0.688 test accuracy on unseen subjects, so
 *     this page says that plainly rather than implying a verdict.
 *
 * Server component: the content is static and the fault table is a constant,
 * so there is no reason to ship React state or a client bundle for it.
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
// What the rep score is made of (docs/FORM_SCORE.md §1, §2 and
// packages/form-engine/src/geometry-scores.ts GEOMETRY_WEIGHTS)
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
    note: 'The deepest elbow bend of the rep. 90° scores 100; the common fault of stopping at 125° scores about 64; never bending at all scores 0.',
  },
  {
    name: 'Alignment',
    weight: '0.30',
    metric: 'body_line_deviation_max_abs',
    note: 'How far the hips strayed from the shoulder-to-ankle line, in torso lengths. Deviations under 0.05 are treated as perfect so landmark noise is not punished. At 0.18 the component scores 0.',
  },
  {
    name: 'Tempo',
    weight: '0.20',
    metric: 'rep_duration_s, descent_duration_s, ascent_duration_s',
    note: 'Half cadence, half symmetry. Anything between 1.2 s and 4.0 s per rep scores full marks; the symmetry half catches reps that dive down and barely push back up.',
  },
  {
    name: 'Consistency',
    weight: '0.10',
    metric: 'elbow angular velocity spread, jitter_score',
    note: 'Stability of the movement, not its speed — how evenly the joints travelled through the rep.',
  },
  {
    name: 'Range of motion',
    weight: '0.10',
    metric: 'rom_elbow_deg',
    note: 'Total elbow travel across the rep. 70° or more is full marks; this is the guard against reps that barely move but still trip the rep counter.',
  },
];

// ---------------------------------------------------------------------------
// Faults. Headlines, details and fixes come from ISSUE_COPY verbatim.
//
// `importance` is the feature importance of the strongest feature each
// detector reads, taken from ml/reports/metrics.json -> feature_importance
// (the pooled gradient-boosting model). `per_view_feature_importance` in that
// file is empty, so a single pooled ranking is all that is available.
// ---------------------------------------------------------------------------

interface Tip {
  code: IssueCode;
  /** The measured feature(s) the detector reads — packages/form-engine/src/assessment.ts detectIssues(). */
  metric: string;
  /** The precondition that must hold before the fault is reported. */
  trigger: string;
  /** Pooled model feature importance of the strongest feature this detector reads. */
  importance: number;
  /** Capture-quality problem rather than a form fault. */
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
    trigger: 'hips more than 0.10 torso-lengths below the shoulder-ankle line',
    importance: 0.105,
  },
  {
    code: 'HIPS_TOO_HIGH',
    metric: 'body_line_deviation_mean',
    trigger: 'hips more than 0.10 torso-lengths above the shoulder-ankle line',
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
    trigger: 'body line varied by more than 0.15 torso-lengths during the rep',
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
    trigger: 'shoulder abduction above 75°, in front or diagonal view only',
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

/**
 * The engine's own reporting order (assessment.ts ISSUE_PRIORITY), used only
 * to break ties in feature importance so the ranking is deterministic.
 */
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

/** Highest feature importance first; ties broken by the engine's own order. */
const RANKED_TIPS = [...TIPS].sort(
  (a, b) => b.importance - a.importance || engineRank(a.code) - engineRank(b.code),
);

// ---------------------------------------------------------------------------

export default function TipsPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold tracking-tight text-ink">Form tips</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            What a good push-up looks like, measured against the same numbers the coach uses while
            you train. Every fault name below is the exact name the app reports mid-set.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/workout" className="btn-primary">
            Start workout
          </Link>
          <Link href="/progress" className="btn-secondary">
            See progress
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* What the score is made of                                        */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-9">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          The five things it measures
        </h2>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-faint">
          Each component is scored 0–100 from measured joint positions, then weighted as shown.
          Geometry accounts for 65% of a rep score and the trained classifier for the remaining
          35%. The weights below are the ones in{' '}
          <code className="font-mono">packages/form-engine/src/geometry-scores.ts</code>.
        </p>

        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {COMPONENTS.map((c) => (
            <li key={c.name} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">{c.name}</h3>
                <span className="tabular font-mono text-xs text-ink-faint">
                  weight {c.weight}
                </span>
              </div>
              <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-ink-muted">
                {c.metric}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-ink-muted">{c.note}</p>
            </li>
          ))}

          <li className="card p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">Model score</h3>
              <span className="tabular font-mono text-xs text-ink-faint">weight 0.35</span>
            </div>
            <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-ink-muted">
              P(good), from the classifier
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              A probability, not a verdict. It is what catches patterns the hand-written rules do
              not encode. If the model cannot load, the score is geometry-only and the app labels it
              as such rather than inventing a model score.
            </p>
          </li>
        </ul>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Faults and their detectors                                       */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Faults the coach can name
        </h2>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-faint">
          Ordered by how much each fault&rsquo;s detection metric mattered to the trained model
          (<code className="font-mono">ml/reports/metrics.json</code>, pooled feature importance);
          ties are broken by the engine&rsquo;s own reporting priority in{' '}
          <code className="font-mono">assessment.ts</code>. Two caveats on that basis: the ranking is
          pooled across camera views, because{' '}
          <code className="font-mono">per_view_feature_importance</code> is empty in the model
          report, and a low importance means the model leaned on the feature little — not that the
          fault is harmless. A fault is only ever reported when its trigger is genuinely satisfied;
          the model alone never produces a fault name.
        </p>

        <ol className="mt-4 list-decimal space-y-4 pl-6 marker:font-mono marker:text-xs marker:text-ink-faint">
          {RANKED_TIPS.map((tip) => {
            const copy = ISSUE_COPY[tip.code];
            return (
              <li key={tip.code} className="card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-ink">{copy.headline}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {tip.captureQuality ? (
                      <span className="chip-neutral">capture quality, not a form fault</span>
                    ) : (
                      <span className="chip-neutral">
                        importance {tip.importance.toFixed(3)}
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-ink-faint">{tip.code}</span>
                  </div>
                </div>

                <p className="mt-2 text-xs leading-relaxed text-ink-muted">{copy.detail}</p>

                <p className="mt-2.5 text-xs leading-relaxed text-ink">
                  <span className="font-semibold">Fix: </span>
                  {copy.tip}
                </p>

                <dl className="mt-3 grid grid-cols-1 gap-2 border-t border-base-border pt-3 sm:grid-cols-2">
                  <div>
                    <dt className="metric-label">Metric that detects it</dt>
                    <dd className="mt-0.5 break-words font-mono text-[11px] text-ink-muted">
                      {tip.metric}
                    </dd>
                  </div>
                  <div>
                    <dt className="metric-label">Reported when</dt>
                    <dd className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                      {tip.trigger}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 max-w-3xl text-xs leading-relaxed text-ink-faint">
          When a rep is judged bad but none of those triggers fires, the app says the movement
          pattern differed from a clean push-up without naming a cause. That is deliberate: a
          specific correction you do not need is worse than an honest &ldquo;something was
          off&rdquo;.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Camera setup                                                     */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          Camera setup
        </h2>
        <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-ink-faint">
          The coach only sees joint positions, so what matters is that the joints it needs are
          visible and the angle makes the geometry readable. The camera check runs these tests before
          counting starts; the thresholds below are the ones in{' '}
          <code className="font-mono">lib/workout-session.ts</code> and{' '}
          <code className="font-mono">docs/POSE_SCHEMA.md</code>.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-ink">Which angle</h3>
            <ol className="mt-3 space-y-3 text-xs leading-relaxed">
              <li>
                <span className="font-medium text-ink">1. Side view — first choice.</span>{' '}
                <span className="text-ink-muted">
                  Depth, body line and tempo are all measured without foreshortening, and those three
                  carry 80% of the geometry weight. This is what the camera check asks for: side
                  dominance of at least 0.55.
                </span>
              </li>
              <li>
                <span className="font-medium text-ink">2. Diagonal — acceptable.</span>{' '}
                <span className="text-ink-muted">
                  Passes the same check, and it is the only view in which elbow flare can be
                  detected. In a pure side view the shoulder angle is foreshortened, so the
                  elbow-flare rule is switched off rather than guessed at.
                </span>
              </li>
              <li>
                <span className="font-medium text-ink">3. Front — last resort.</span>{' '}
                <span className="text-ink-muted">
                  Elbow flare and hip angle read well, but chest depth and body line are compressed
                  by the perspective, which is exactly what the two heaviest components need.
                </span>
              </li>
            </ol>
            <p className="mt-3 border-t border-base-border pt-3 text-xs leading-relaxed text-ink-faint">
              On our 205-rep test split the diagonal clips scored highest (0.766) and side clips
              second-lowest (0.659), against 0.631 for front. Those cells hold only 44–84 reps from
              four unseen subjects, so we treat them as indicative rather than conclusive, and we
              still recommend the side view for the reason above.
            </p>
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-ink">Where to put the camera</h3>
            <ul className="mt-3 space-y-2.5 text-xs leading-relaxed text-ink-muted">
              <li>
                Roughly level with your chest or shoulder, a couple of metres back, looking across
                the length of your body rather than down it.
              </li>
              <li>
                Your whole body must be in frame, feet included. The app rejects a frame when the
                ankles are clipped at the bottom edge or the head is clipped at the top, and tells
                you to move further from the camera instead of scoring partial data.
              </li>
              <li>
                Distance is checked as well as framing: the body must span between 0.12 and 0.75 of
                the frame. Too close or too far both fail, with different instructions.
              </li>
              <li>
                The app requests 1280×720 at 30 fps. A higher resolution costs CPU in the pose loop
                and does not improve the measurements.
              </li>
            </ul>
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-ink">Lighting and surroundings</h3>
            <ul className="mt-3 space-y-2.5 text-xs leading-relaxed text-ink-muted">
              <li>
                Light yourself from the front or the side. Strong backlighting — a window or a lamp
                behind you — turns you into a silhouette and the joints stop being tracked.
              </li>
              <li>
                Calibration needs an average landmark visibility of at least 0.6 on the side facing
                the camera. During the set, any frame below 0.5 is discarded rather than
                interpolated, because a guessed hip position would produce an alignment reading that
                looks good precisely when the camera could not see you.
              </li>
              <li>
                Keep the background plain and keep other people out of frame. A second person stops
                the session outright.
              </li>
              <li>
                Fitted clothing helps. Loose fabric around the hips is the most common cause of
                unstable hip tracking.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* What the score means                                             */}
      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-muted">
          What the score means
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-ink">How a number is produced</h3>

            <ul className="mt-3 space-y-2.5 text-xs leading-relaxed text-ink-muted">
              <li>
                <span className="font-mono text-[11px] text-ink">
                  rep score = 0.65 × geometry + 0.35 × model
                </span>
                <br />
                Both halves are reported separately, so you can see whether a low score came from a
                measurement or from the classifier.
              </li>
              <li>
                A rep counts as valid only when both conditions hold: P(good) is at or above the
                tuned threshold of 0.58, <em>and</em> the geometry score is at least 55. The second
                condition catches reps the model likes that break a hard rule such as badly sagging
                hips.
              </li>
              <li>
                Your session score is the mean of every rep, valid and invalid alike. Invalid reps
                are counted and shown, never quietly dropped.
              </li>
              <li>
                With no reps recorded the score reads <span className="font-mono">--</span>, not 0.
                With fewer than three reps it is shown as provisional, because one rep is a poor
                estimate of anyone&rsquo;s form.
              </li>
            </ul>
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-ink">How much to trust it</h3>

            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              The classifier is a binary good/bad model trained on 917 reps from 24 people. It was
              trained on 16 subjects and tested on 4 it had never seen, which is the honest way to
              measure it — and the reason the numbers are modest.
            </p>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              <Stat term="Test accuracy" value="0.688" />
              <Stat term="Macro F1" value="0.672" />
              <Stat term="ROC AUC" value="0.702" />
              <Stat term="Bad-form recall" value="0.585" />
            </dl>

            <p className="mt-3 text-xs leading-relaxed text-ink-muted">
              Bad-form recall of 0.585 means roughly four in ten genuinely bad reps are labelled
              good. Per-subject accuracy across the four test subjects ranged from 0.444 to 0.861,
              so the score is partly a measure of how well the model generalises to you. Treat
              P(good) as an estimate, not a verdict.
            </p>

            <p className="mt-3 border-t border-base-border pt-3 text-xs leading-relaxed text-ink-faint">
              The app behaves the same way. When P(good) lands within 0.08 of the threshold it
              reports the rep as borderline rather than asserting good or bad, and the uncertainty
              is shown on screen instead of being rounded away.
            </p>
          </div>
        </div>

        <div className="card mt-4 p-4">
          <h3 className="text-sm font-semibold text-ink">What it does not claim</h3>
          <ul className="mt-3 grid grid-cols-1 gap-2 text-xs leading-relaxed text-ink-muted md:grid-cols-2">
            <li>Which muscle is weak, or what to stretch.</li>
            <li>Hand placement width — not recoverable from wrist landmarks in side view.</li>
            <li>Head or neck position.</li>
            <li>Calories, &ldquo;strength&rdquo;, or any other physiological estimate.</li>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Everything shown is derived from joint positions in the camera feed. Frames are analysed
            for pose estimation and are not stored.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}

      <section className="mt-10">
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">Ready to try it</h2>
            <p className="mt-1 text-xs text-ink-muted">
              The camera check will confirm your framing and angle before the first rep counts.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/workout" className="btn-primary">
              Start workout
            </Link>
            <Link href="/challenge" className="btn-secondary">
              30-second challenge
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
    <div>
      <dt className="metric-label">{term}</dt>
      <dd className="tabular mt-1 text-lg font-semibold text-ink">{value}</dd>
    </div>
  );
}
