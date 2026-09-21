'use client';

/**
 * app/challenge/page.tsx
 *
 * Agent 4 — PRODUCT FEATURE ENGINEER (challenge → leaderboard flow)
 *
 * The IT-fest exhibition mode: 30 seconds, maximum VALID reps.
 *
 * ---------------------------------------------------------------------------
 * The ranking rule, read from `rankEntries()` in lib/session-store.ts
 * (identical to docs/DATABASE_SCHEMA.md §3 — the SQL ORDER BY matches the
 * comparator key for key):
 *
 *   1. validReps       DESC  (primary)
 *   2. formScore       DESC  (tie-break 1)
 *   3. durationSeconds ASC   (tie-break 2 — shorter wins)
 *   4. createdAt       ASC   (final, makes the order total/deterministic)
 *
 * The page below states that rule in full. Only valid reps move the rank;
 * bad reps are recorded and shown but never score, which is what stops a
 * fast sloppy set from winning.
 *
 * ---------------------------------------------------------------------------
 * Decisions this file makes, and why
 *
 * 1. ONE SUBMISSION PER FINISHED RUN, ADDITIVE.
 *    `saveLeaderboardEntry()` only ever appends, `loadLeaderboard()` only
 *    filters nothing, and the database denies UPDATE/DELETE to clients
 *    (DATABASE_SCHEMA.md §4). So the honest rule is "each finished run adds
 *    one entry, nothing is overwritten" — stated in the UI. A single run can
 *    never post twice: `finishedRef` makes `finishChallenge` idempotent.
 *
 * 2. NOTHING IS FABRICATED.
 *    `LeaderboardEntry.formScore` is `number` (not nullable) and the column is
 *    `numeric(5,2)` with `CHECK (form_score >= 0 AND form_score <= 100)`, so the
 *    schema cannot represent "not measured". A run with 0 reps has a null form
 *    score, so it is BLOCKED with an explanation rather than stored as a
 *    measured-looking 0. The session itself is still saved to history.
 *    Every stored number comes from `session.getMetrics()`.
 *
 * 3. THE SESSION WRITE AND THE LEADERBOARD WRITE ARE SEPARATE.
 *    `saveSession()` would write the leaderboard row itself when given a
 *    `displayName` — and would store `formScore ?? 0`, i.e. the fabrication in
 *    (2). It is called WITHOUT `displayName` so the entry is written here,
 *    where it can be validated, reported and never duplicated. The session
 *    record is unaffected: `displayName` is not part of `WorkoutSessionRecord`.
 *
 * 4. DURATION IS SAMPLED BEFORE THE FIRST `await`.
 *    `WorkoutSession.getElapsedSeconds()` keeps ticking until `reset()`, so
 *    awaiting the camera teardown before reading it inflated every stored
 *    duration — and duration is a leaderboard tie-break.
 *
 * ---------------------------------------------------------------------------
 * Deliberate deviation from docs/UX_FLOW.md §10.1
 *
 * The doc says a blank name becomes 'Anonymous'. This page requires a name
 * instead: a board of Anonymous rows ranks nobody, and the requirement is an
 * explicit, honest empty-name state. `sanitizeName()`'s `|| 'Anonymous'`
 * fallback is left untouched in the store as the data-layer safety net; the UI
 * simply never reaches it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { CameraStage, poseBridgeRef, type CameraStageHandle } from '@/components/CameraStage';
import { CameraEngine, makeCaptureError } from '@/lib/camera';
import { PoseEngine } from '@ai-pushup-coach/pose';
import { WorkoutSession, type SessionSnapshot } from '@/lib/workout-session';
import { getFormModel, loadFormModel } from '@ai-pushup-coach/form-engine';
import type { FormModel } from '@ai-pushup-coach/form-engine';
import {
  loadLeaderboard,
  saveLeaderboardEntry,
  saveSession,
  sanitizeName,
} from '@/lib/session-store';
import { formatInt, formatPercent, formatSeconds } from '@/lib/format';
import type { CaptureError, LeaderboardEntry, WorkoutMetrics } from '@ai-pushup-coach/types';

const CHALLENGE_SECONDS = 30;
/** Must equal the cap inside `sanitizeName()` (lib/session-store.ts). */
const NAME_MAX = 24;

type Stage = 'entry' | 'ready' | 'running' | 'done' | 'error';

/** The measured outcome of one finished run. Never synthesised. */
interface RunResult {
  metrics: WorkoutMetrics;
  durationSeconds: number;
  name: string;
}

type Submission =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; message: string };

/**
 * Mirrors `sanitizeName()` minus the final `trim()`, so the user watches the
 * name being normalised while typing instead of discovering it was mangled
 * after the run. The trim is applied on submit and previewed in the hint.
 */
function normalizeNameInput(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, NAME_MAX);
}

export default function ChallengePage() {
  const cameraRef = useRef<CameraEngine | null>(null);
  const poseRef = useRef<PoseEngine | null>(null);
  const sessionRef = useRef<WorkoutSession | null>(null);
  const stageRef = useRef<CameraStageHandle | null>(null);
  const tickRef = useRef<number | null>(null);
  /** Guards against a second submission of the same finished run. */
  const finishedRef = useRef(false);

  const [mounted, setMounted] = useState(false);
  const [stage, setStage] = useState<Stage>('entry');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<CaptureError | null>(null);
  const [model, setModel] = useState<FormModel | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [remaining, setRemaining] = useState(CHALLENGE_SECONDS);
  const [videoDims, setVideoDims] = useState({ w: 1280, h: 720 });
  const [result, setResult] = useState<RunResult | null>(null);
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });
  /** Runs already recorded in this browser. Read after mount only. */
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // Storage read must happen after mount: localStorage does not exist during
  // the server render, and reading it while rendering would make the server
  // and client markup disagree (Next 15 hydration error).
  useEffect(() => {
    setBoard(loadLeaderboard());
    setMounted(true);
  }, []);

  // Load model
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await loadFormModel('/models');
      if (!cancelled) setModel(m ?? getFormModel());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Camera teardown
  useEffect(() => {
    const camera = new CameraEngine();
    cameraRef.current = camera;
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
      poseRef.current?.close();
      poseRef.current = null;
      void camera.stop();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Leaderboard write — the only place an entry is ever created
  // -------------------------------------------------------------------------

  const submitEntry = useCallback(async (run: RunResult) => {
    const formScore = run.metrics.formScore;

    // No rep completed => the form score is null. `leaderboard_entries.form_score`
    // is NOT NULL with a 0–100 CHECK, so there is no honest value to store:
    // writing 0 would assert a measured 0% form. Block instead.
    if (run.metrics.totalReps === 0) {
      setSubmission({
        status: 'blocked',
        reason:
          'No rep was counted, so no form score exists. A score of 0 would be a made-up measurement, not a result.',
      });
      return;
    }
    if (formScore === null || !Number.isFinite(formScore)) {
      setSubmission({
        status: 'blocked',
        reason:
          'The form score could not be computed for this run. The board only stores measured scores, so nothing was posted.',
      });
      return;
    }

    setSubmission({ status: 'saving' });
    try {
      // Every field is a real measurement from the finished session.
      await saveLeaderboardEntry({
        displayName: run.name,
        validReps: run.metrics.validReps,
        invalidReps: run.metrics.invalidReps,
        formScore,
        durationSeconds: run.durationSeconds,
        bestStreak: run.metrics.bestStreak,
        mode: 'challenge30',
      });
      setSubmission({ status: 'saved' });
      // Re-read rather than appending locally, so this card shows exactly what
      // /leaderboard will show.
      setBoard(loadLeaderboard());
    } catch (err) {
      // The store writes localStorage before the optional remote mirror and
      // swallows quota errors, so reaching here means the local write itself
      // failed — i.e. nothing was stored and a retry cannot duplicate a row.
      setSubmission({
        status: 'failed',
        message: err instanceof Error ? err.message : 'The browser refused the storage write.',
      });
    }
  }, []);

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------

  const finishChallenge = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || finishedRef.current) return;
    finishedRef.current = true;

    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }

    // Sample the clock BEFORE any await. getElapsedSeconds() keeps running
    // until reset(), so reading it after the camera teardown would inflate the
    // stored duration — and duration is a leaderboard tie-break.
    const elapsed = session.getElapsedSeconds();
    session.finish();
    setSnapshot(session.buildSnapshotForUi());

    const metrics = session.getMetrics();
    const durationSeconds = Math.max(0, Math.round(elapsed));
    const startedAt = new Date(Date.now() - elapsed * 1000).toISOString();
    const endedAt = new Date().toISOString();
    const displayName = sanitizeName(name);

    const run: RunResult = { metrics, durationSeconds, name: displayName };
    setResult(run);
    setStage('done');

    poseRef.current?.stop();
    await cameraRef.current?.stop();

    // History first. No `displayName`: that would make saveSession() write its
    // own leaderboard row, and it would store `formScore ?? 0` (see the header).
    try {
      await saveSession({
        startedAt,
        endedAt,
        durationSeconds,
        metrics,
        reps: session.getRepRecords(),
        viewType: 'side',
        mode: 'challenge',
      });
    } catch {
      // History is a nice-to-have; it must never block the score.
    }

    await submitEntry(run);
  }, [name, submitEntry]);

  const beginChallenge = useCallback(async () => {
    const camera = cameraRef.current;
    const video = stageRef.current?.getVideo();
    if (!camera || !video) {
      setError(makeCaptureError('INIT_FAILED'));
      setStage('error');
      return;
    }

    try {
      await camera.start(video, { width: 1280, height: 720, fps: 30 });
    } catch (err) {
      setError(err as CaptureError);
      setStage('error');
      return;
    }

    setVideoDims({ w: video.videoWidth || 1280, h: video.videoHeight || 720 });

    if (!poseRef.current) {
      poseRef.current = new PoseEngine({
        targetFps: 20,
        onFrame: (frame) => poseBridgeRef.current?.(frame),
      });
    }
    const engine = poseRef.current;
    const ok = await engine.init();
    if (!ok) {
      // Stop the stream before leaving this stage: an orphaned MediaStream
      // keeps the camera LED on, which reads as spyware at a public booth.
      await camera.stop();
      setError(makeCaptureError('MODEL_UNAVAILABLE'));
      setStage('error');
      return;
    }

    const session = new WorkoutSession({
      mode: 'challenge',
      view: 'side',
      model,
      callbacks: {
        onSnapshot: (s) => setSnapshot(s),
        onRep: () => {},
      },
    });
    sessionRef.current = session;
    finishedRef.current = false;

    engine.start(video);
    session.start();
    setResult(null);
    setSubmission({ status: 'idle' });
    setSnapshot(null);
    setStage('running');
    setRemaining(CHALLENGE_SECONDS);

    // Countdown. Driven from wall-clock rather than frame count so a slow frame
    // rate cannot extend the challenge.
    const deadline = performance.now() + CHALLENGE_SECONDS * 1000;
    tickRef.current = window.setInterval(() => {
      const left = Math.max(0, (deadline - performance.now()) / 1000);
      setRemaining(left);
      if (left <= 0) {
        if (tickRef.current) {
          window.clearInterval(tickRef.current);
          tickRef.current = null;
        }
        void finishChallenge();
      }
    }, 100);
  }, [finishChallenge, model]);

  const restart = useCallback(() => {
    sessionRef.current?.reset();
    finishedRef.current = false;
    setSnapshot(null);
    setResult(null);
    setSubmission({ status: 'idle' });
    setRemaining(CHALLENGE_SECONDS);
    setStage('ready');
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const pageMeta = (
    <>
      <title>30 Second Challenge — AI Push-Up Coach</title>
      <meta
        name="description"
        content="Thirty seconds of maximum valid push-ups, scored live and ranked by valid reps, then form score, then the shortest run."
      />
    </>
  );

  // Pre-mount: neutral skeleton. Nothing here reads storage or guesses at data.
  if (!mounted) {
    return (
      <div className="mx-auto max-w-lg px-5 py-14" aria-busy="true" aria-label="Loading challenge">
        {pageMeta}
        <div className="mx-auto h-6 w-32 animate-pulse rounded bg-base-raised" />
        <div className="mx-auto mt-4 h-9 w-64 animate-pulse rounded bg-base-raised" />
        <div className="mx-auto mt-3 h-4 w-80 animate-pulse rounded bg-base-raised" />
        <div className="mt-7 h-72 animate-pulse rounded-card bg-base-raised" />
      </div>
    );
  }

  if (stage === 'entry') {
    const cleanName = sanitizeName(name);
    const nameValid = cleanName.length > 0;
    const wasTrimmed = name !== cleanName;

    return (
      <div className="mx-auto max-w-lg px-5 py-14">
        {pageMeta}
        <div className="text-center">
          <span className="chip-neutral">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            IT Fest mode
          </span>
          <h1 className="mt-4 text-display font-semibold tracking-tight text-ink">
            30 Second Challenge
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            Maximum <span className="font-medium text-accent">valid</span> push-ups in 30 seconds.
            Only clean reps count toward your score — a rushed bad rep scores nothing.
          </p>
        </div>

        <form
          className="card mt-7 p-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameValid) {
              setNameError('Enter a name before you start — the board has to show something.');
              return;
            }
            setNameError(null);
            setStage('ready');
          }}
        >
          <label htmlFor="challenge-name" className="metric-label">
            Enter your name
          </label>
          <input
            id="challenge-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(normalizeNameInput(e.target.value));
              setNameError(null);
            }}
            placeholder="Your name"
            maxLength={NAME_MAX}
            autoComplete="off"
            required
            aria-invalid={!nameValid && name.length > 0}
            aria-describedby="challenge-name-hint"
            className={clsx(
              'mt-2 w-full rounded-control border bg-base px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint',
              !nameValid && name.length > 0 ? 'border-danger-dim' : 'border-base-border',
              'focus-visible:border-accent',
            )}
          />
          <p
            id="challenge-name-hint"
            className={clsx('mt-1.5 text-xs', nameError ? 'text-danger' : 'text-ink-faint')}
            aria-live="polite"
          >
            {nameError ??
              (nameValid
                ? `Saved to the board as “${cleanName}”.${
                    wasTrimmed
                      ? ' Leading and trailing spaces are trimmed.'
                      : ` ${NAME_MAX - cleanName.length} characters left.`
                  }`
                : `A name is required — it is what the board shows. Letters, numbers and spaces, up to ${NAME_MAX} characters.`)}
          </p>

          <button
            type="submit"
            className="btn-primary mt-4 w-full"
            disabled={!nameValid}
            aria-describedby="challenge-name-hint"
          >
            Continue
          </button>
          <Link href="/leaderboard" className="btn-ghost mt-2 w-full">
            View leaderboard
          </Link>
        </form>

        {/* Real state of this browser's board, read from storage after mount. */}
        <div className="card mt-4 p-5">
          <h2 className="metric-label">This browser</h2>
          {board.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-muted">
              No challenge runs recorded here yet. Your first finished run posts a score.
            </p>
          ) : (
            <>
              <p className="mt-1.5 text-sm text-ink-muted">
                <span className="tabular text-ink">{formatInt(board.length)}</span>{' '}
                {board.length === 1 ? 'run' : 'runs'} recorded here. Best so far:{' '}
                <span className="tabular font-medium text-accent">
                  {formatInt(board[0]?.validReps ?? null)}
                </span>{' '}
                valid reps.
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                Each finished run adds its own entry — nothing is overwritten, so a second attempt
                adds a second row.
              </p>
            </>
          )}
        </div>

        <div className="card mt-4 p-5">
          <h2 className="text-sm font-semibold text-ink">How the board is ranked</h2>
          <ol className="mt-3 space-y-2 text-xs leading-relaxed text-ink-muted">
            <li>
              <span className="text-ink">1. Valid reps</span> — most first.
            </li>
            <li>
              <span className="text-ink">2. Form score</span> — highest first.
            </li>
            <li>
              <span className="text-ink">3. Duration</span> — shortest first.
            </li>
            <li>
              <span className="text-ink">4. Submitted at</span> — earliest first.
            </li>
          </ol>
          <p className="mt-3 text-xs text-ink-faint">
            Bad reps are recorded and shown but never count toward rank, so a fast sloppy set cannot
            win.
          </p>
        </div>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="mx-auto max-w-lg px-5 py-14">
        {pageMeta}
        {error && <ErrorBanner error={error} />}
        <div className="mt-4 flex flex-wrap gap-2">
          {error?.recoverable && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setError(null);
                setStage('ready');
              }}
            >
              Back to the start line
            </button>
          )}
          <Link href="/" className="btn-secondary">
            Leave the challenge
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-6">
      {pageMeta}
      {error && <ErrorBanner error={error} />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label="Challenge camera">
          <CameraStage
            ref={stageRef}
            /*
             * Must forward to the session. CameraStage publishes its own
             * handler onto the module level `poseBridgeRef`; that ref carries
             * frames INTO the stage. This prop is the way back out, so a no-op
             * here means the overlay animates while the rep counter never
             * advances and the challenge can never be completed.
             */
            onPoseFrame={(frame) => {
              sessionRef.current?.onPoseFrame(frame);
            }}
            isLive={stage === 'running'}
            overlayMessage={
              snapshot?.pausedReason === 'pose-lost' ? 'Pose lost — step back into frame' : null
            }
            videoWidth={videoDims.w}
            videoHeight={videoDims.h}
          />

          {stage === 'ready' && (
            <div className="mt-4">
              <button className="btn-primary" onClick={beginChallenge}>
                Start 30 seconds
              </button>
              <p className="mt-2 text-xs text-ink-faint">
                Get into position first — the countdown starts the moment you press this. This mode
                is scored from the side, so turn sideways to the camera with your whole body,
                including your feet, in frame.
              </p>
            </div>
          )}
        </section>

        <section aria-label="Challenge status" className="flex flex-col gap-4">
          {/* Big countdown — the defining element of this mode */}
          <div className="card p-5 text-center border-base-border/90 bg-gradient-to-b from-base-raised to-base-sunken/90">
            <div className="flex items-center justify-center gap-2">
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse-dot" />
              <div className="metric-label">Time remaining</div>
            </div>
            <div
              className={clsx(
                'tabular mt-2 font-display font-black tracking-tight',
                remaining <= 5 && stage === 'running' ? 'text-danger animate-pulse' : 'text-ink',
              )}
              style={{ fontSize: '4.5rem', lineHeight: 1 }}
              aria-live="off"
            >
              {formatSeconds(stage === 'done' ? 0 : remaining, 1)}
            </div>
            <div className="mt-1 font-mono text-xs text-ink-faint uppercase tracking-wider">seconds remaining</div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <div className="card p-4 border-accent/30 bg-accent/[0.04] shadow-glow-sm">
              <div className="metric-label text-accent">Valid reps</div>
              <div className="tabular mt-1 font-display text-metric font-black text-accent">
                {formatInt(snapshot?.metrics.validReps ?? null)}
              </div>
            </div>
            <div className="card p-4 border-danger/30 bg-danger/[0.04]">
              <div className="metric-label text-danger">Bad reps</div>
              <div className="tabular mt-1 font-display text-metric font-black text-danger">
                {formatInt(snapshot?.metrics.invalidReps ?? null)}
              </div>
            </div>
          </div>

          <div className="card p-4 border-base-border/90 bg-base-raised/90">
            <div className="metric-label">Form score</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="tabular font-display text-metric font-black text-ink">
                {formatInt(snapshot?.metrics.formScore ?? null)}
              </span>
              <span className="text-sm font-mono text-ink-faint">/ 100</span>
            </div>
            {snapshot?.metrics.scoreStatus === 'insufficient-data' && (
              <p className="mt-1 text-xs text-ink-faint">Complete a rep to score</p>
            )}
          </div>

          {stage === 'running' && (
            <div className="card p-4">
              <p className="text-xs leading-relaxed text-ink-muted">
                Only valid reps score. Keep your form clean — a fast sloppy rep earns nothing and
                still costs you the time.
              </p>
            </div>
          )}

          {stage === 'done' && result && (
            <div className="card border-accent-deep bg-accent-wash p-5">
              <div className="metric-label text-accent">Final result</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="tabular text-metric font-bold text-accent">
                  {formatInt(result.metrics.validReps)}
                </span>
                <span className="text-sm text-ink-muted">valid reps</span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <dt className="metric-label">Bad reps</dt>
                  <dd className="tabular mt-1 text-sm text-ink">
                    {formatInt(result.metrics.invalidReps)}
                  </dd>
                </div>
                <div>
                  <dt className="metric-label">Form score</dt>
                  <dd className="tabular mt-1 text-sm text-ink">
                    {formatPercent(result.metrics.formScore, 0)}
                  </dd>
                </div>
                <div>
                  <dt className="metric-label">Duration</dt>
                  <dd className="tabular mt-1 text-sm text-ink">
                    {formatSeconds(result.durationSeconds, 0)}s
                  </dd>
                </div>
                <div>
                  <dt className="metric-label">Best streak</dt>
                  <dd className="tabular mt-1 text-sm text-ink">
                    {formatInt(result.metrics.bestStreak)}
                  </dd>
                </div>
              </dl>

              <SubmissionNote
                submission={submission}
                name={result.name}
                onRetry={() => void submitEntry(result)}
              />

              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/leaderboard" className="btn-primary">
                  View leaderboard
                </Link>
                <button type="button" className="btn-secondary" onClick={restart}>
                  Try again
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * The submission outcome, stated plainly. Every branch is a real state: there
 * is no placeholder text and no optimistic "saved" before the write resolves.
 */
function SubmissionNote({
  submission,
  name,
  onRetry,
}: {
  submission: Submission;
  name: string;
  onRetry: () => void;
}) {
  if (submission.status === 'saving') {
    return (
      <p className="mt-4 text-sm text-ink-muted" role="status" aria-live="polite">
        Posting your score…
      </p>
    );
  }

  if (submission.status === 'saved') {
    return (
      <div
        className="mt-4 rounded-control border border-accent-deep bg-base p-3"
        role="status"
        aria-live="polite"
      >
        <div className="text-sm font-medium text-accent">Posted to the leaderboard</div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
          Recorded as “{name}”. This run is one entry — a further attempt adds another row rather
          than replacing this one.
        </p>
      </div>
    );
  }

  if (submission.status === 'blocked') {
    return (
      <div
        className="mt-4 rounded-control border border-warn bg-warn-wash p-3"
        role="status"
        aria-live="polite"
      >
        <div className="text-sm font-medium text-ink">Not posted — nothing measurable to rank</div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{submission.reason}</p>
        <p className="mt-1 text-xs text-ink-faint">
          The run is still saved to your workout history on Progress.
        </p>
      </div>
    );
  }

  if (submission.status === 'failed') {
    return (
      <div className="mt-4 rounded-control border border-danger-dim bg-danger-wash p-3" role="alert">
        <div className="text-sm font-medium text-ink">Could not post your score</div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{submission.message}</p>
        <button type="button" className="btn-secondary mt-2" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  return null;
}

function ErrorBanner({ error }: { error: CaptureError }) {
  return (
    <div className="rounded-card border border-danger-dim bg-danger-wash p-4" role="alert">
      <div className="font-medium text-ink">{error.title}</div>
      <p className="mt-0.5 text-sm text-ink-muted">{error.detail}</p>
    </div>
  );
}
