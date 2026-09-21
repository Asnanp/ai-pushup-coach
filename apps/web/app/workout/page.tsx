'use client';

/**
 * app/workout/page.tsx
 *
 * Agent 4 (shell) + Agent 15 (session) + Agent 14 (feedback)
 *
 * The main training screen. Layout mirrors the supplied reference:
 *   header            -> AppHeader (layout level)
 *   left  ~60%        -> live camera with pose overlay
 *   right ~40%        -> timer, END WORKOUT, metric cards, form analysis
 *   bottom full width -> feedback panel + contextual tip
 *
 * Real-time discipline: this component re-renders at most ~4x/second, driven
 * by the session's throttled snapshots. The skeleton is drawn to canvas and
 * never enters React state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { CameraStage, poseBridgeRef, type CameraStageHandle } from '@/components/CameraStage';
import { MetricCard, MeterRow } from '@/components/MetricCard';
import { CameraEngine, makeCaptureError } from '@/lib/camera';
import { PoseEngine, type PoseStatus } from '@ai-pushup-coach/pose';
import {
  WorkoutSession,
  type SessionPhase,
  type SessionSnapshot,
} from '@/lib/workout-session';
import { getFormModel, loadFormModel, type FormModel } from '@ai-pushup-coach/form-engine';
import { buildFeedback, tipForIssue } from '@ai-pushup-coach/form-engine';
import { saveSession } from '@/lib/session-store';
import type {
  CameraView,
  CaptureError,
  FormLabel,
  IssueCode,
  RepAssessment,
} from '@ai-pushup-coach/types';
import { CalibrationPanel } from '@/components/CalibrationPanel';
import { formatClock, formatInt, formatPercent } from '@/lib/format';

export default function WorkoutPage() {
  const cameraRef = useRef<CameraEngine | null>(null);
  const poseRef = useRef<PoseEngine | null>(null);
  const sessionRef = useRef<WorkoutSession | null>(null);
  const stageRef = useRef<CameraStageHandle | null>(null);

  /**
   * The page's view state IS the session state machine (`SessionPhase`) — there
   * is no second, parallel union. `'paused'` is a real phase (pose loss
   * auto-pauses after 12 invalid frames) and must be representable here, or the
   * paused UI could never render.
   */
  const [phase, setPhase] = useState<SessionPhase>('idle');
  /**
   * Camera / model failures are surfaced through their own channel rather than
   * by overloading the phase union with an invented `'error'` state: a failed
   * `getUserMedia` happens while the session is still `'idle'`.
   */
  const [error, setError] = useState<CaptureError | null>(null);
  const [poseStatus, setPoseStatus] = useState<PoseStatus>('idle');
  /**
   * Which asset source the pose runtime actually loaded from. Reported in the
   * camera check so an operator can confirm the offline path engaged instead of
   * taking it on faith.
   */
  const [assetSource, setAssetSource] = useState<string | null>(null);
  const [model, setModel] = useState<FormModel | null>(null);
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  /** Full per-rep assessment — the snapshot's reduced view drops `borderline`. */
  const [lastAssessment, setLastAssessment] = useState<RepAssessment | null>(null);
  const [videoDims, setVideoDims] = useState({ w: 1280, h: 720 });
  const [view, setView] = useState<CameraView>('side');
  const [calibrationReady, setCalibrationReady] = useState(false);

  const failWith = useCallback((p: CaptureError) => {
    setError(p);
  }, []);

  // -------------------------------------------------------------------------
  // Model bootstrap
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await loadFormModel('/models');
      if (cancelled) return;
      // Keep the deterministic geometry engine as the fallback; the UI states
      // which source is in use rather than hiding the difference.
      setModel(m ?? getFormModel());
      setModelAvailable(m !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Camera + pose lifecycle
  //
  // Cleanup is critical: a leaked MediaStream leaves the camera light on after
  // the user navigates away, and leaks a rAF loop.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const camera = new CameraEngine();
    cameraRef.current = camera;
    return () => {
      poseRef.current?.close();
      poseRef.current = null;
      void camera.stop();
      cameraRef.current = null;
    };
  }, []);

  const startCamera = useCallback(async () => {
    const camera = cameraRef.current;
    if (!camera) return false;

    const video = stageRef.current?.getVideo();
    if (!video) return false;

    try {
      await camera.start(video, { width: 1280, height: 720, fps: 30 });
      setVideoDims({
        w: video.videoWidth || 1280,
        h: video.videoHeight || 720,
      });
      setError(null);
      return true;
    } catch (err) {
      failWith(err as CaptureError);
      return false;
    }
  }, [failWith]);

  const startPose = useCallback(async () => {
    if (!poseRef.current) {
      poseRef.current = new PoseEngine({
        targetFps: 20,
        onStatus: (s) => setPoseStatus(s),
        onFrame: (frame) => {
          // Straight into the session; no React state involved.
          poseBridgeRef.current?.(frame);
        },
      });
    }

    const engine = poseRef.current;
    const ok = await engine.init();
    if (!ok) {
      failWith(makeCaptureError('MODEL_UNAVAILABLE'));
      return false;
    }
    setAssetSource(engine.getAssetSource());

    const video = stageRef.current?.getVideo();
    if (!video) return false;

    engine.start(video);
    return true;
  }, [failWith]);

  // -------------------------------------------------------------------------
  // Session control
  // -------------------------------------------------------------------------
  const handleStart = useCallback(async () => {
    const cameraOk = await startCamera();
    if (!cameraOk) return;

    const poseOk = await startPose();
    if (!poseOk) return;

    const s = new WorkoutSession({
      mode: 'workout',
      view,
      model,
      callbacks: {
        onSnapshot: (snap) => {
          setSnapshot(snap);
          // The session owns the phase; the page mirrors it rather than
          // maintaining its own idea of where the workout is.
          setPhase(snap.phase);
        },
        // Keep the FULL assessment, not just the snapshot's reduced
        // LiveRepFeedback: `buildFeedback()` needs the real `borderline` and
        // `confidence` values to express uncertainty honestly.
        onRep: (assessment) => setLastAssessment(assessment),
      },
    });
    sessionRef.current = s;
    s.beginCalibration();
    setPhase('calibrating');
  }, [model, startCamera, startPose, view]);

  const handleBeginCounting = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.start();
    setPhase('active');
  }, []);

  const handleEnd = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;

    s.finish();
    poseRef.current?.stop();
    await cameraRef.current?.stop();

    const metrics = s.getMetrics();
    const records = s.getRepRecords();

    // Persist. Never stores video — only the numeric results.
    await saveSession({
      startedAt: new Date(Date.now() - s.getElapsedSeconds() * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round(s.getElapsedSeconds()),
      metrics,
      reps: records,
      viewType: view,
      mode: 'workout',
    });

    setSnapshot(s.buildSnapshotForUi());
    setPhase('finished');
  }, [view]);

  // -------------------------------------------------------------------------
  // Derived UI values — every one comes from a real measurement or is null.
  // -------------------------------------------------------------------------
  const metrics = snapshot?.metrics ?? null;
  /**
   * The complete `RepAssessment` from `onRep` is the single source for the
   * feedback panel, the component meters and the tip. It carries the real
   * `borderline` / `confidence` flags, so a rep that sits within 0.08 of the
   * decision threshold is reported as "Good rep — just" instead of being
   * asserted as a clean verdict. Building a synthetic assessment here (as this
   * page used to, with `borderline: false` and `confidence: 0` hardcoded) made
   * the borderline branch unreachable and mislabelled the score source.
   */
  const components = lastAssessment?.components ?? null;
  const feedback = lastAssessment ? buildFeedback(lastAssessment) : null;

  const overlayMessage = error
    ? null
    : phase === 'idle'
      ? 'Press START WORKOUT to begin'
      : phase === 'paused'
        ? snapshot?.pausedReason === 'pose-lost'
          ? 'Pose lost — step back into frame'
          : 'Workout paused'
        : null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (phase === 'finished') {
    return <SessionResult onRestart={() => window.location.reload()} />;
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-5">
      {error && <ErrorBanner error={error} onRetry={() => window.location.reload()} />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ---------------- LEFT: camera ---------------- */}
        <section aria-label="Live camera">
          <CameraStage
            ref={stageRef}
            /*
             * This MUST forward to the session. CameraStage owns the module
             * level `poseBridgeRef` and publishes its own internal handler
             * there; that ref is the path INTO the stage, not out of it. The
             * pose engine therefore lands frames on CameraStage, which draws
             * the skeleton and then calls this prop.
             *
             * Leaving this as a no-op meant frames were drawn but never
             * reached WorkoutSession, so the rep counter never advanced and
             * every metric stayed empty while the camera looked fine.
             */
            onPoseFrame={(frame) => {
              sessionRef.current?.onPoseFrame(frame);
            }}
            isLive={phase === 'active' || phase === 'calibrating'}
            overlayMessage={overlayMessage}
            videoWidth={videoDims.w}
            videoHeight={videoDims.h}
          />

          {phase === 'idle' && !error && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button className="btn-primary" onClick={handleStart}>
                <PlayIcon />
                Start Workout
              </button>
              <ViewSelector value={view} onChange={setView} />
              {modelAvailable === false && (
                <span className="chip-neutral">
                  Rule-based scoring (model not loaded)
                </span>
              )}
            </div>
          )}

          {phase === 'calibrating' && (
            <div className="mt-4">
              <CalibrationPanel
                poseStatus={poseStatus}
                session={sessionRef.current}
                onReady={setCalibrationReady}
                onStartCounting={handleBeginCounting}
                assetSource={assetSource}
              />
            </div>
          )}

          {phase === 'active' && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="chip-neutral">
                <span className="font-mono text-[11px]">
                  elbow{' '}
                  {snapshot && Number.isFinite(snapshot.liveElbowAngle)
                    ? `${formatInt(snapshot.liveElbowAngle)}°`
                    : '--'}
                </span>
              </span>
              <span className="chip-neutral">
                state {snapshot?.repState ?? '--'}
              </span>
              <span className="chip-neutral">
                cycle {snapshot ? formatPercent(snapshot.cycleProgress * 100, 0) : '--'}
              </span>
              <div className="flex-1" />
              <p className="text-xs text-ink-faint">
                Camera frames are analyzed for pose estimation and are not stored.
              </p>
            </div>
          )}
        </section>

        {/* ---------------- RIGHT: metrics ---------------- */}
        <section aria-label="Workout metrics" className="flex flex-col gap-4">
          {/* Timer + end */}
          <div className="card flex items-center gap-4 p-4">
            <TimerIcon active={phase === 'active'} />
            <div className="flex-1">
              <div className="metric-label">Workout time</div>
              <div className="tabular text-metricSm font-bold text-ink">
                {formatClock(snapshot?.elapsedSeconds)}
              </div>
              {phase === 'paused' && (
                <div className="mt-1 text-xs text-warn">
                  Paused —{' '}
                  {snapshot?.pausedReason === 'pose-lost'
                    ? 'pose lost, counting stopped'
                    : 'counting stopped'}
                </div>
              )}
            </div>
            <button
              className="btn-danger"
              onClick={handleEnd}
              // Paused is included deliberately: a session that auto-paused
              // because the pose was lost must still be endable and saveable.
              disabled={
                phase !== 'active' && phase !== 'calibrating' && phase !== 'paused'
              }
            >
              <StopIcon />
              End Workout
            </button>
          </div>

          {/* Rep counters */}
          <div className="grid grid-cols-3 gap-4">
            <MetricCard
              label="Reps"
              value={metrics ? metrics.totalReps : null}
              emphasis
              caption={metrics && metrics.totalReps === 0 ? 'waiting' : undefined}
            />
            <MetricCard
              label="Valid reps"
              value={metrics ? metrics.validReps : null}
              tone="good"
              emphasis
            />
            <MetricCard
              label="Invalid reps"
              value={metrics ? metrics.invalidReps : null}
              tone="bad"
              emphasis
            />
          </div>

          {/*
            The rep tally changes without any user action, so it is a polite
            live region. The feedback panel announces the quality of each rep;
            this announces the count, which the headline does not carry.
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {metrics
              ? `${metrics.totalReps} reps recorded, ${metrics.validReps} valid, ${metrics.invalidReps} invalid.`
              : 'No reps recorded yet.'}
          </p>

          {/* Form score */}
          <div className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="metric-label">Form score</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="tabular text-metric font-bold tracking-tight text-ink">
                    {formatInt(metrics?.formScore)}
                  </span>
                  <span className="text-lg text-ink-faint">/ 100</span>
                </div>
                {metrics?.scoreStatus === 'provisional' && (
                  <div className="mt-1 text-xs text-warn">Provisional — under 3 reps</div>
                )}
                {metrics?.scoreStatus === 'insufficient-data' && (
                  <div className="mt-1 text-xs text-ink-faint">Complete a rep to score</div>
                )}
              </div>
              <ScoreBadge score={metrics?.formScore ?? null} />
            </div>
          </div>

          {/* Form analysis */}
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink">Form analysis</h2>
              <Link
                href="/tips"
                className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              >
                See details
              </Link>
            </div>
            <div className="flex flex-col gap-3">
              <MeterRow label="Depth" value={components?.depth ?? null} />
              <MeterRow label="Body alignment" value={components?.alignment ?? null} />
              <MeterRow label="Tempo" value={components?.tempo ?? null} />
              <MeterRow
                label="Consistency"
                value={components?.consistency ?? null}
              />
              {/*
                Range of motion is a real scored component (weight 0.10 in
                FORM_SCORE.md §2) and is folded into repScore, so it is shown
                live like the other four rather than being hidden.
              */}
              <MeterRow label="Range of motion" value={components?.rom ?? null} />
            </div>
            {!lastAssessment && (
              <p className="mt-3 text-xs text-ink-faint">
                Live per-rep breakdown appears after your first rep.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* ---------------- BOTTOM: feedback ---------------- */}
      <section className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <FeedbackPanel feedback={feedback} />
        <TipPanel issue={lastAssessment?.primaryIssue ?? null} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FeedbackPanel({
  feedback,
}: {
  feedback: ReturnType<typeof buildFeedback> | null;
}) {
  const tone = feedback?.tone ?? 'neutral';
  const iconBg =
    tone === 'positive'
      ? 'bg-accent text-base'
      : tone === 'corrective'
        ? 'bg-danger text-white'
        : tone === 'warning'
          ? 'bg-warn text-base'
          : 'bg-base-border text-ink';

  return (
    <div className="card flex items-center gap-4 p-5" role="status" aria-live="polite">
      <div
        className={clsx(
          'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
          iconBg,
        )}
        aria-hidden="true"
      >
        {tone === 'positive' ? <CheckIcon /> : tone === 'corrective' ? <AlertIcon /> : <InfoIcon />}
      </div>
      <div className="min-w-0">
        <div className="metric-label">Feedback</div>
        <div className="mt-0.5 text-lg font-semibold text-ink">
          {feedback?.headline ?? 'Waiting for your first rep'}
        </div>
        <p className="mt-0.5 text-sm text-ink-muted">
          {feedback?.detail ??
            'Get into position and start your set. Feedback appears after each rep.'}
        </p>
      </div>
    </div>
  );
}

function TipPanel({ issue }: { issue: IssueCode | null }) {
  return (
    <div className="card p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true">
          <BulbIcon />
        </span>
        <div>
          <div className="metric-label">Tip</div>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{tipForIssue(issue)}</p>
        </div>
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null || !Number.isFinite(score)) {
    return <span className="text-xs text-ink-faint">--</span>;
  }
  const good = score >= 75;
  const mid = score >= 55 && score < 75;
  return (
    <div className="flex items-center gap-3">
      <BarsIcon value={score} />
      <div className="text-right">
        <div className={clsx('text-sm font-medium', good ? 'text-accent' : mid ? 'text-warn' : 'text-danger')}>
          {good ? 'Good form' : mid ? 'Needs work' : 'Poor form'}
        </div>
        <div className="text-xs text-ink-faint">
          {good ? 'Keep it consistent.' : 'Check the breakdown.'}
        </div>
      </div>
    </div>
  );
}

function BarsIcon({ value }: { value: number }) {
  const levels = [0.4, 0.65, 0.9];
  return (
    <span className="flex items-end gap-[3px]" aria-hidden="true">
      {levels.map((l, i) => {
        const on = value / 100 >= l;
        return (
          <span
            key={i}
            className={clsx('w-[4px] rounded-sm', on ? 'bg-accent' : 'bg-base-border')}
            style={{ height: `${10 + i * 6}px` }}
          />
        );
      })}
    </span>
  );
}

function ViewSelector({
  value,
  onChange,
}: {
  value: CameraView;
  onChange: (v: CameraView) => void;
}) {
  const options: { v: CameraView; label: string }[] = [
    { v: 'side', label: 'Side' },
    { v: 'diagonal', label: 'Diagonal' },
    { v: 'front', label: 'Front' },
  ];
  return (
    <div
      className="flex items-center gap-1 rounded-control border border-base-border bg-base-raised p-1"
      role="radiogroup"
      aria-label="Camera angle"
    >
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={clsx(
            'rounded-chip px-3 py-1.5 text-xs font-medium transition-colors',
            value === o.v
              ? 'bg-base-hover text-ink'
              : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: CaptureError; onRetry: () => void }) {
  return (
    <div
      className="mb-5 flex items-start gap-3 rounded-card border border-danger-dim bg-danger-wash p-4"
      role="alert"
    >
      <span className="mt-0.5 text-danger" aria-hidden="true">
        <AlertIcon />
      </span>
      <div className="flex-1">
        <div className="font-medium text-ink">{error.title}</div>
        <p className="mt-0.5 text-sm text-ink-muted">{error.detail}</p>
      </div>
      {error.recoverable && (
        <button className="btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function SessionResult({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-5 py-16 text-center">
      <h1 className="text-display font-semibold text-ink">Session complete</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Your results were saved. Open Progress to see your history.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button className="btn-primary" onClick={onRestart}>
          Try again
        </button>
        <Link href="/progress" className="btn-secondary">
          View progress
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons (inline, no icon library dependency)
// ---------------------------------------------------------------------------

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 3 L12.5 8 L4.5 13 Z" fill="currentColor" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
    </svg>
  );
}
function TimerIcon({ active }: { active: boolean }) {
  return (
    <span
      className={clsx(
        'flex h-10 w-10 items-center justify-center rounded-full border',
        active ? 'border-accent-deep text-accent' : 'border-base-border text-ink-faint',
      )}
      aria-hidden="true"
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10.5" r="7" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 6.5 V10.5 L13 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M7.5 2.5 H12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}
function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5 L10 17.5 L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 8 V13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11 V16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="8" r="1.1" fill="currentColor" />
    </svg>
  );
}
function BulbIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 18 h6 M10 21 h4 M12 3 a6 6 0 0 0 -3.5 10.9 V15 h7 v-1.1 A6 6 0 0 0 12 3 Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
