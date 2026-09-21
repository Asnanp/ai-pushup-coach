'use client';

/**
 * app/workout/page.tsx
 *
 * Agent 4 (shell) + Agent 15 (session) + Agent 13/14 (coach & voice) + Agent 2/3 (view awareness)
 *
 * The main V2 training screen:
 *   left  ~60%        -> live camera with pose overlay + dev diagnostics overlay
 *   right ~40%        -> timer, end workout, view/voice selectors, rep tallies, form meters
 *   bottom full width -> live intelligent coaching feedback + correction recognition + tips
 *   finished screen   -> complete rep-by-rep breakdown with depth, alignment, tempo, ROM,
 *                        correction status, ML P(good), and coach messages
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
  type DevDiagnosticsSnapshot,
  type SessionPhase,
  type SessionSnapshot,
} from '@/lib/workout-session';
import { getFormModel, loadFormModel, type FormModel } from '@ai-pushup-coach/form-engine';
import { buildFeedback, tipForIssue } from '@ai-pushup-coach/form-engine';
import type { VoiceCoachMode } from '@ai-pushup-coach/coach-engine';
import { saveSession } from '@/lib/session-store';
import type {
  CameraView,
  CaptureError,
  IssueCode,
  RepAssessment,
  UserViewMode,
  WorkoutRepRecord,
} from '@ai-pushup-coach/types';
import { CalibrationPanel } from '@/components/CalibrationPanel';
import { LiveMotionGraph, type LiveMotionGraphHandle } from '@/components/LiveMotionGraph';
import { formatClock, formatInt, formatPercent } from '@/lib/format';

export default function WorkoutPage() {
  const cameraRef = useRef<CameraEngine | null>(null);
  const poseRef = useRef<PoseEngine | null>(null);
  const sessionRef = useRef<WorkoutSession | null>(null);
  const stageRef = useRef<CameraStageHandle | null>(null);
  const motionGraphRef = useRef<LiveMotionGraphHandle | null>(null);

  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [error, setError] = useState<CaptureError | null>(null);
  const [poseStatus, setPoseStatus] = useState<PoseStatus>('idle');
  const [assetSource, setAssetSource] = useState<string | null>(null);
  const [model, setModel] = useState<FormModel | null>(null);
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [lastAssessment, setLastAssessment] = useState<RepAssessment | null>(null);
  const [videoDims, setVideoDims] = useState({ w: 1280, h: 720 });
  const [userViewMode, setUserViewMode] = useState<UserViewMode>('AUTO');
  const [voiceMode, setVoiceMode] = useState<VoiceCoachMode>('NORMAL');
  const [showDebug, setShowDebug] = useState(false);
  const [calibrationReady, setCalibrationReady] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [finishedRecords, setFinishedRecords] = useState<WorkoutRepRecord[]>([]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('debug') === '1') setShowDebug(true);
  }, []);

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
      setModel(m ?? getFormModel());
      setModelAvailable(m !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Camera + pose lifecycle
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
      view: userViewMode,
      model,
      voiceMode,
      callbacks: {
        onSnapshot: (snap) => {
          setSnapshot(snap);
          setPhase(snap.phase);
        },
        onRep: (assessment) => setLastAssessment(assessment),
        onMotionSample: (sample) => motionGraphRef.current?.pushSample(sample),
      },
    });
    sessionRef.current = s;
    s.beginCalibration();
    setPhase('calibrating');
  }, [model, startCamera, startPose, userViewMode, voiceMode]);

  const handleBeginCounting = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    s.start();
    setPhase('active');
    window.setTimeout(() => setCountdown(null), 900);
  }, []);

  const handleEnd = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;

    s.finish();
    poseRef.current?.stop();
    await cameraRef.current?.stop();

    const metrics = s.getMetrics();
    const records = s.getRepRecords();
    setFinishedRecords(records);

    await saveSession({
      startedAt: new Date(Date.now() - s.getElapsedSeconds() * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: Math.round(s.getElapsedSeconds()),
      metrics,
      reps: records,
      viewType: (snapshot?.view ?? 'side') as CameraView,
      mode: 'workout',
    });

    setSnapshot(s.buildSnapshotForUi());
    setPhase('finished');
  }, [snapshot?.view]);

  const handleViewChange = (v: UserViewMode) => {
    setUserViewMode(v);
    sessionRef.current?.setUserViewMode(v);
  };

  const handleVoiceChange = (m: VoiceCoachMode) => {
    setVoiceMode(m);
    sessionRef.current?.setVoiceMode(m);
  };

  const metrics = snapshot?.metrics ?? null;
  const components = lastAssessment?.components ?? null;
  const feedback = lastAssessment ? buildFeedback(lastAssessment) : null;
  const coachAction = snapshot?.lastCoachAction ?? null;

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
  // Render finished result
  // -------------------------------------------------------------------------
  if (phase === 'finished') {
    return (
      <SessionResult
        metrics={metrics}
        reps={finishedRecords}
        elapsedSeconds={snapshot?.elapsedSeconds ?? 0}
        onRestart={() => window.location.reload()}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-5">
      {error && <ErrorBanner error={error} onRetry={() => window.location.reload()} />}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* ---------------- LEFT: camera ---------------- */}
        <section aria-label="Live camera" className="relative">
          <CameraStage
            ref={stageRef}
            onPoseFrame={(frame) => {
              sessionRef.current?.onPoseFrame(frame);
            }}
            isLive={phase === 'active' || phase === 'calibrating'}
            overlayMessage={overlayMessage}
            videoWidth={videoDims.w}
            videoHeight={videoDims.h}
          />

          {/* Development Debug Diagnostics Overlay (Spec §29) */}
          {showDebug && snapshot?.diagnostics && (
            <DevDiagnosticsOverlay
              diagnostics={snapshot.diagnostics}
              onExport={() => {
                const json = sessionRef.current?.getV3Engine().traces.exportJSON();
                if (!json) return;
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `pushup-live-trace-${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            />
          )}

          {phase === 'idle' && !error && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className="btn-primary px-6 py-2.5 text-xs font-semibold uppercase tracking-wider"
                onClick={handleStart}
              >
                <PlayIcon />
                Start Workout
              </button>
              <ViewSelector value={userViewMode} onChange={handleViewChange} />
              <VoiceSelector value={voiceMode} onChange={handleVoiceChange} />
              <button
                className={clsx(
                  'btn-secondary text-xs font-mono uppercase tracking-wider',
                  showDebug && 'bg-base-hover border-ink text-ink',
                )}
                onClick={() => setShowDebug((d) => !d)}
              >
                {showDebug ? 'Hide Debug' : 'Debug'}
              </button>
              {modelAvailable === false && (
                <span className="chip-neutral font-mono text-[11px]">
                  Rule-based scoring (model not loaded)
                </span>
              )}
            </div>
          )}

          {/* Hands-Free Auto-Start Countdown Overlay */}
          {countdown !== null &&
            (phase === 'calibrating' ||
              (countdown === 0 && (snapshot?.elapsedSeconds ?? 0) < 1.1)) && (
            <div
              className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center rounded-card bg-base/80 backdrop-blur-sm animate-fade-in"
              role="status"
              aria-live="assertive"
            >
              <div className="flex h-24 w-24 items-center justify-center rounded-full border border-ink/80 bg-base-raised shadow-sm">
                <span className="text-4xl font-extrabold text-ink tabular font-mono">
                  {countdown > 0 ? countdown : 'GO'}
                </span>
              </div>
              <p className="mt-4 text-sm font-semibold tracking-wide uppercase text-ink">
                {countdown > 0 ? 'Get into push-up position' : 'Begin Push-Ups!'}
              </p>
            </div>
          )}

          {phase === 'calibrating' && (
            <div className="mt-4">
              <CalibrationPanel
                poseStatus={poseStatus}
                session={sessionRef.current}
                onReady={setCalibrationReady}
                onStartCounting={handleBeginCounting}
                onCountdownChange={setCountdown}
                assetSource={assetSource}
              />
            </div>
          )}

          {phase === 'active' && (
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-ink-muted">
              <div>
                <span className="text-ink-faint">Elbow: </span>
                <span className="font-semibold text-ink">
                  {snapshot && Number.isFinite(snapshot.liveElbowAngle)
                    ? `${formatInt(snapshot.liveElbowAngle)}°`
                    : '--'}
                </span>
              </div>
              <div>
                <span className="text-ink-faint">State: </span>
                <span className="font-semibold text-ink">
                  {snapshot?.repState ?? '--'}
                </span>
              </div>
              <div>
                <span className="text-ink-faint">View: </span>
                <span className="font-semibold text-ink">
                  {snapshot?.detectedV2View?.replace('VIEW_', '') ?? userViewMode}
                </span>
              </div>
              <div className="flex-1" />
              <button
                className="text-xs text-ink-faint hover:text-ink cursor-pointer"
                onClick={() => setShowDebug((d) => !d)}
              >
                {showDebug ? 'Hide debug' : 'Debug'}
              </button>
            </div>
          )}

          {/* Real-time Push-Up Motion Oscilloscope Graph */}
          {(phase === 'active' || phase === 'calibrating') && (
            <LiveMotionGraph ref={motionGraphRef} height={130} className="mt-3" />
          )}
        </section>

        {/* ---------------- RIGHT: metrics ---------------- */}
        <section aria-label="Workout metrics" className="flex flex-col gap-4">
          {/* Timer + end */}
          <div className="card flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <TimerIcon active={phase === 'active'} />
              <div>
                <div className="metric-label">Time</div>
                <div className="tabular text-2xl font-bold text-ink">
                  {formatClock(snapshot?.elapsedSeconds)}
                </div>
                {phase === 'paused' && (
                  <div className="mt-0.5 text-xs text-warn">
                    Paused — {snapshot?.pausedReason === 'pose-lost' ? 'pose lost' : 'stopped'}
                  </div>
                )}
              </div>
            </div>
            <button
              className="btn-danger"
              onClick={handleEnd}
              disabled={
                phase !== 'active' && phase !== 'calibrating' && phase !== 'paused'
              }
            >
              <StopIcon />
              End Workout
            </button>
          </div>

          {/* Rep counters (Total / Valid / Invalid / Uncertain) */}
          <div className="grid grid-cols-4 gap-2 sm:gap-3">
            <MetricCard
              label="Reps"
              value={metrics ? metrics.totalReps : null}
              emphasis
              caption={metrics && metrics.totalReps === 0 ? 'waiting' : undefined}
            />
            <MetricCard
              label="Valid"
              value={metrics ? metrics.validReps : null}
              tone="good"
              emphasis
            />
            <MetricCard
              label="Invalid"
              value={metrics ? metrics.invalidReps : null}
              tone="bad"
              emphasis
            />
            <MetricCard
              label="Uncertain"
              value={metrics ? (metrics.uncertainReps ?? 0) : null}
              emphasis
            />
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {metrics
              ? `${metrics.totalReps} reps recorded, ${metrics.validReps} valid, ${metrics.invalidReps} invalid.`
              : 'No reps recorded yet.'}
          </p>

          {/* Form score */}
          <div className="card p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="metric-label">Form Score</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="tabular text-metric font-bold text-ink">
                    {formatInt(metrics?.formScore)}
                  </span>
                  <span className="text-sm text-ink-faint">/100</span>
                </div>
                {metrics?.scoreStatus === 'provisional' && (
                  <div className="mt-1 text-xs text-warn">Provisional (under 3 reps)</div>
                )}
                {metrics?.scoreStatus === 'insufficient-data' && (
                  <div className="mt-1 text-xs text-ink-faint">Complete a rep to score</div>
                )}
              </div>
              <ScoreBadge score={metrics?.formScore ?? null} />
            </div>
          </div>

          {/* Form analysis meters */}
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
              <MeterRow label="Consistency" value={components?.consistency ?? null} />
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
        <FeedbackPanel feedback={feedback} coachAction={coachAction} />
        <TipPanel issue={lastAssessment?.primaryIssue ?? null} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DevDiagnosticsOverlay({
  diagnostics,
  onExport,
}: {
  diagnostics: DevDiagnosticsSnapshot;
  onExport?: () => void;
}) {
  return (
    <div
      className="absolute top-3 left-3 z-30 max-w-xs rounded-card border border-accent/40 bg-base/90 p-3 backdrop-blur font-mono text-[10px] text-ink shadow-lg"
      aria-label="Development diagnostics"
    >
      <div className="mb-1.5 flex items-center justify-between border-b border-base-border pb-1 font-bold text-accent">
        <span>V3 LIVE DIAGNOSTICS</span>
        <span className="rounded bg-accent/20 px-1 text-[9px]">{diagnostics.fsmState}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        <span className="text-ink-muted">View:</span>
        <span className="text-right font-semibold">{diagnostics.detectedView} ({(diagnostics.viewConfidence * 100).toFixed(0)}%)</span>

        <span className="text-ink-muted">L / R Elbow:</span>
        <span className="text-right">{diagnostics.elbowLeft?.toFixed(0) ?? '--'}° / {diagnostics.elbowRight?.toFixed(0) ?? '--'}°</span>

        <span className="text-ink-muted">Comb. Elbow:</span>
        <span className="text-right font-semibold text-accent">{diagnostics.elbowCombined?.toFixed(0) ?? '--'}°</span>

        <span className="text-ink-muted">2D / 3D Signal:</span>
        <span className="text-right">{diagnostics.elbow2D?.toFixed(0) ?? '--'} / {diagnostics.elbow3D?.toFixed(2) ?? '--'}</span>

        <span className="text-ink-muted">ROM Top/Bot:</span>
        <span className="text-right">{diagnostics.romTop?.toFixed(0) ?? '--'}° / {diagnostics.romBottom?.toFixed(0) ?? '--'}°</span>

        <span className="text-ink-muted">Phase Progress:</span>
        <span className="text-right">{((diagnostics.normalizedPhase ?? 0) * 100).toFixed(0)}%</span>

        <span className="text-ink-muted">Pose Conf:</span>
        <span className="text-right">{((diagnostics.poseConfidence ?? 0) * 100).toFixed(0)}%</span>

        <span className="text-ink-muted">Sh/Hip Depth:</span>
        <span className="text-right">{diagnostics.shoulderDepth?.toFixed(2) ?? '--'} / {diagnostics.hipDepth?.toFixed(2) ?? '--'}</span>
      </div>
      <div className="mt-1.5 border-t border-base-border pt-1 text-[9px] text-ink-muted">
        {diagnostics.recalibrationStatus}
      </div>
      {onExport && (
        <button
          type="button"
          className="mt-2 w-full rounded border border-accent/40 px-2 py-1 text-[10px] text-accent"
          onClick={onExport}
        >
          Export debug JSON
        </button>
      )}
    </div>
  );
}

function FeedbackPanel({
  feedback,
  coachAction,
}: {
  feedback: ReturnType<typeof buildFeedback> | null;
  coachAction: any | null;
}) {
  const isCorrection = coachAction?.isCorrection ?? false;
  const headline = isCorrection
    ? coachAction.message
    : coachAction?.message ?? feedback?.headline ?? 'Waiting for your first rep';

  const tone = isCorrection
    ? 'positive'
    : feedback?.tone ?? 'neutral';

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
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="metric-label">Feedback</span>
          {isCorrection && (
            <span className="rounded-chip bg-accent/20 px-2 py-0.5 text-[11px] font-bold text-accent">
              CORRECTED
            </span>
          )}
        </div>
        <div className="mt-0.5 text-lg font-semibold text-ink">
          {headline}
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
    return <span className="text-xs text-ink-faint font-mono">--</span>;
  }
  const good = score >= 75;
  const mid = score >= 55 && score < 75;
  return (
    <span
      className={clsx(
        'rounded-chip px-2.5 py-0.5 text-xs font-medium border',
        good
          ? 'border-accent/40 bg-accent/10 text-accent'
          : mid
            ? 'border-warn/40 bg-warn/10 text-warn'
            : 'border-danger/40 bg-danger/10 text-danger',
      )}
    >
      {good ? 'Good form' : mid ? 'Moderate' : 'Needs work'}
    </span>
  );
}

function ViewSelector({
  value,
  onChange,
}: {
  value: UserViewMode;
  onChange: (v: UserViewMode) => void;
}) {
  const options: { v: UserViewMode; label: string }[] = [
    { v: 'AUTO', label: 'Auto' },
    { v: 'FRONT', label: 'Front' },
    { v: 'SIDE', label: 'Side' },
    { v: 'DIAGONAL', label: 'Diagonal' },
  ];
  return (
    <div
      className="flex items-center rounded-control border border-base-border bg-base-sunken p-0.5 text-xs"
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
            'rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
            value === o.v
              ? 'bg-base-raised text-ink font-semibold'
              : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function VoiceSelector({
  value,
  onChange,
}: {
  value: VoiceCoachMode;
  onChange: (v: VoiceCoachMode) => void;
}) {
  const options: { v: VoiceCoachMode; label: string }[] = [
    { v: 'OFF', label: 'Mute' },
    { v: 'NORMAL', label: 'Voice' },
    { v: 'ACTIVE', label: 'Active' },
  ];
  return (
    <div
      className="flex items-center rounded-control border border-base-border bg-base-sunken p-0.5 text-xs"
      role="radiogroup"
      aria-label="Voice coach mode"
    >
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={clsx(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer',
            value === o.v
              ? 'bg-base-raised text-ink font-semibold'
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

function SessionResult({
  metrics,
  reps,
  elapsedSeconds,
  onRestart,
}: {
  metrics: any;
  reps: WorkoutRepRecord[];
  elapsedSeconds: number;
  onRestart: () => void;
}) {
  const [selectedRep, setSelectedRep] = useState<WorkoutRepRecord | null>(null);

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:py-12">
      <div className="text-center">
        <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-600">
          <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Workout Complete
        </h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Session recorded locally · Duration: <span className="font-mono text-ink font-bold">{formatClock(elapsedSeconds)}</span>
        </p>
      </div>

      {/* Overview Cards */}
      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4 text-center">
          <div className="metric-label">Total Reps</div>
          <div className="mt-1 text-3xl font-bold text-ink">{metrics?.totalReps ?? 0}</div>
        </div>
        <div className="card p-4 text-center">
          <div className="metric-label text-accent">Valid Reps</div>
          <div className="mt-1 text-3xl font-bold text-accent">{metrics?.validReps ?? 0}</div>
        </div>
        <div className="card p-4 text-center">
          <div className="metric-label text-danger">Invalid Reps</div>
          <div className="mt-1 text-3xl font-bold text-danger">{metrics?.invalidReps ?? 0}</div>
        </div>
        <div className="card p-4 text-center">
          <div className="metric-label">Form Score</div>
          <div className="mt-1 text-3xl font-bold text-ink">
            {metrics?.formScore !== null && Number.isFinite(metrics?.formScore) ? `${formatInt(metrics.formScore)}` : '--'}
            <span className="text-xs text-ink-faint font-normal"> /100</span>
          </div>
        </div>
      </div>

      {/* Visual Rep Performance Graph */}
      <SessionRepChart
        reps={reps}
        selectedRep={selectedRep}
        onSelectRep={setSelectedRep}
      />

      {/* Rep-by-Rep Breakdown (Spec §30) */}
      <div className="mt-8 card p-5">
        <h2 className="text-base font-semibold text-ink">Rep-by-Rep Form Breakdown</h2>
        <p className="text-xs text-ink-muted mt-1">
          Click any repetition to inspect measured geometric components and ML probability.
        </p>

        {reps.length === 0 ? (
          <p className="mt-4 text-sm text-ink-faint italic text-center py-6">No repetitions completed.</p>
        ) : (
          <div className="mt-4 divide-y divide-base-border overflow-hidden rounded-control border border-base-border">
            {reps.map((r) => {
              const status = r.uncertain
                ? 'UNCERTAIN'
                : r.valid
                  ? 'VALID'
                  : 'INVALID';
              const statusBg =
                status === 'VALID'
                  ? 'bg-accent/15 text-accent'
                  : status === 'INVALID'
                    ? 'bg-danger/15 text-danger'
                    : 'bg-warn/15 text-warn';

              return (
                <div
                  key={r.repNumber}
                  onClick={() => setSelectedRep(r)}
                  className="flex cursor-pointer items-center justify-between p-3.5 transition-colors hover:bg-base-raised"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-bold text-ink">#{r.repNumber}</span>
                    <span className={clsx('rounded px-2 py-0.5 text-xs font-semibold', statusBg)}>
                      {status}
                    </span>
                    {r.isCorrection && (
                      <span className="rounded bg-accent/20 px-2 py-0.5 text-[11px] font-bold text-accent">
                        ✓ CORRECTED
                      </span>
                    )}
                    {r.detectedIssue && (
                      <span className="text-xs text-ink-muted">
                        Issue: <span className="font-medium text-ink">{r.detectedIssue.replace(/_/g, ' ')}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono text-ink">
                    <span>Score: <strong>{r.repScore?.toFixed(0) ?? '--'}</strong></span>
                    <span>Depth: {r.depthScore?.toFixed(0) ?? '--'}</span>
                    <span className="text-ink-muted text-sm">›</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rep Details Modal */}
      {selectedRep && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setSelectedRep(null)}
        >
          <div
            className="w-full max-w-md rounded-card border border-base-border bg-base p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-base-border pb-3">
              <h3 className="text-lg font-bold text-ink">Rep #{selectedRep.repNumber} Assessment</h3>
              <button
                className="text-ink-muted hover:text-ink text-sm font-bold"
                onClick={() => setSelectedRep(null)}
              >
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-muted">Verdict:</span>
                <span className="font-bold">
                  {selectedRep.uncertain ? 'UNCERTAIN' : selectedRep.valid ? 'VALID (GOOD)' : 'INVALID (BAD)'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">ML P(good):</span>
                <span className="font-mono">{Number.isFinite(selectedRep.formProbability) ? (selectedRep.formProbability * 100).toFixed(1) + '%' : 'Geometry Only'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Overall Rep Score:</span>
                <span className="font-mono font-bold">{selectedRep.repScore?.toFixed(1) ?? '--'} / 100</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Depth Score:</span>
                <span className="font-mono">{selectedRep.depthScore?.toFixed(1) ?? '--'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Alignment Score:</span>
                <span className="font-mono">{selectedRep.alignmentScore?.toFixed(1) ?? '--'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Tempo Score:</span>
                <span className="font-mono">{selectedRep.tempoScore?.toFixed(1) ?? '--'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Duration:</span>
                <span className="font-mono">{selectedRep.repDurationSeconds?.toFixed(2) ?? '--'} s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-muted">Min Elbow Angle:</span>
                <span className="font-mono">{selectedRep.minElbowAngleDeg?.toFixed(0) ?? '--'}°</span>
              </div>
              {selectedRep.coachMessage && (
                <div className="mt-3 rounded border border-base-border bg-base-raised p-2 text-xs">
                  <span className="font-semibold text-accent">Coach:</span> "{selectedRep.coachMessage}"
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <button className="btn-secondary" onClick={() => setSelectedRep(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navigation actions */}
      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <button
          className="btn-primary px-6 py-2.5 text-xs font-semibold uppercase tracking-wider"
          onClick={onRestart}
        >
          Start Another Set
        </button>
        <Link href="/progress" className="btn-secondary px-5 py-2.5 text-xs font-medium uppercase tracking-wider">
          View Progress &amp; Trends
        </Link>
        <Link href="/challenge" className="btn-secondary px-5 py-2.5 text-xs font-medium uppercase tracking-wider">
          30s Challenge
        </Link>
        <Link href="/leaderboard" className="btn-ghost py-3 px-4 font-semibold text-ink-muted hover:text-ink">
          Leaderboard
        </Link>
      </div>
    </div>
  );
}

function SessionRepChart({
  reps,
  selectedRep,
  onSelectRep,
}: {
  reps: WorkoutRepRecord[];
  selectedRep: WorkoutRepRecord | null;
  onSelectRep: (r: WorkoutRepRecord) => void;
}) {
  if (reps.length === 0) return null;

  return (
    <div className="card p-5 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">Rep Performance Curve</h3>
          <p className="text-xs text-ink-muted">Form score and depth per repetition</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-accent">
            <span className="h-2 w-2 rounded-sm bg-accent" />
            Valid (≥75)
          </span>
          <span className="flex items-center gap-1.5 text-danger">
            <span className="h-2 w-2 rounded-sm bg-danger" />
            Needs work
          </span>
          <span className="flex items-center gap-1.5 text-warn">
            <span className="h-2 w-2 rounded-sm bg-warn" />
            Uncertain
          </span>
        </div>
      </div>

      <div className="relative h-44 w-full">
        {/* 75 Good form threshold line */}
        <div
          className="absolute left-0 right-0 border-b border-dashed border-accent/40 z-10 pointer-events-none flex justify-end"
          style={{ bottom: '75%' }}
        >
          <span className="text-[10px] font-mono text-accent pr-1 bg-base/80 rounded">
            75 TARGET
          </span>
        </div>

        {/* 50 Baseline */}
        <div
          className="absolute left-0 right-0 border-b border-dashed border-base-border/50 z-10 pointer-events-none flex justify-end"
          style={{ bottom: '50%' }}
        >
          <span className="text-[10px] font-mono text-ink-faint pr-1">50</span>
        </div>

        {/* Rep Bars */}
        <div className="absolute inset-0 flex items-end gap-1.5 sm:gap-2 px-2">
          {reps.map((r) => {
            const barHeight = Math.max(8, Math.min(100, r.repScore ?? 50));
            const isSelected = selectedRep?.repNumber === r.repNumber;
            const barColor = r.uncertain
              ? 'bg-warn'
              : r.valid
                ? 'bg-accent'
                : 'bg-danger';

            return (
              <button
                key={r.repNumber}
                onClick={() => onSelectRep(r)}
                className={clsx(
                  'relative group flex-1 flex flex-col items-center justify-end rounded-t transition-all hover:brightness-110 focus:outline-none',
                  isSelected && 'ring-2 ring-white ring-offset-2 ring-offset-base',
                )}
                style={{ height: '100%' }}
                aria-label={`Rep #${r.repNumber}: Score ${r.repScore?.toFixed(0) ?? '--'}, min angle ${r.minElbowAngleDeg?.toFixed(0) ?? '--'}°`}
              >
                {/* Tooltip on hover */}
                <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity z-20 pointer-events-none rounded bg-base-sunken px-2 py-1 text-[10px] font-mono text-ink shadow whitespace-nowrap border border-base-border">
                  #{r.repNumber}: {r.repScore?.toFixed(0)} pts · {r.minElbowAngleDeg?.toFixed(0)}°
                </div>

                {/* The Bar */}
                <div
                  className={clsx('w-full rounded-t transition-all', barColor)}
                  style={{ height: `${barHeight}%` }}
                />

                {/* Rep label */}
                <span className="mt-1 text-[10px] font-mono text-ink-muted">
                  #{r.repNumber}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Icons
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
