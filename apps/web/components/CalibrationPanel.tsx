'use client';

/**
 * components/CalibrationPanel.tsx
 *
 * Agent 2 (UX) + Agent 5 (calibration) + Agent 6 (pose)
 *
 * Two-stage calibration panel:
 *   Phase A: Camera alignment & framing check
 *   Phase B: Movement calibration ("Perform 2 normal push-ups so we can learn your movement range")
 *
 * Prevents the standing-lockout failure by requiring genuine range of motion before READY.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CalibrationCheck, CalibrationPhase } from '@ai-pushup-coach/types';
import type { PoseStatus } from '@ai-pushup-coach/pose';
import { WorkoutSession } from '@/lib/workout-session';
import { formatInt } from '@/lib/format';

interface Props {
  poseStatus: PoseStatus;
  session: WorkoutSession | null;
  onReady: (ready: boolean) => void;
  onStartCounting: () => void;
  onCountdownChange?: (countdown: number | null) => void;
  assetSource?: string | null;
}

export function CalibrationPanel({
  poseStatus,
  session,
  onReady,
  onStartCounting,
  onCountdownChange,
  assetSource,
}: Props) {
  const [checks, setChecks] = useState<CalibrationCheck[]>([]);
  const [samples, setSamples] = useState(0);
  const [elbowNow, setElbowNow] = useState<number | null>(null);
  const [calibPhase, setCalibPhase] = useState<CalibrationPhase>('CAMERA_CHECK');
  const [repsDone, setRepsDone] = useState(0);
  const [repsNeeded, setRepsNeeded] = useState(2);
  const [promptMsg, setPromptMsg] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState(true);

  const autoStartFiredRef = useRef(false);
  const onStartCountingRef = useRef(onStartCounting);
  onStartCountingRef.current = onStartCounting;

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => {
      const s = session.getCalibrationState();
      setChecks(s.checks);
      setSamples(s.samples);
      setElbowNow(s.liveElbowAngle);
      if (s.calibrationPhase) setCalibPhase(s.calibrationPhase);
      if (typeof s.calibrationRepsCompleted === 'number') setRepsDone(s.calibrationRepsCompleted);
      if (typeof s.calibrationRepsRequired === 'number') setRepsNeeded(s.calibrationRepsRequired);
      if (s.feedbackPrompt) setPromptMsg(s.feedbackPrompt);
    }, 200);
    return () => window.clearInterval(id);
  }, [session]);

  const ready = useMemo(
    () => checks.length > 0 && checks.every((c) => c.passed),
    [checks],
  );

  useEffect(() => {
    onReady(ready);
  }, [ready, onReady]);

  // Sync countdown to parent so live camera stage can render giant numerals
  useEffect(() => {
    onCountdownChange?.(countdown);
  }, [countdown, onCountdownChange]);

  // Hands-free auto-countdown when calibration is complete
  useEffect(() => {
    if (!ready || !autoStartEnabled) return;
    if (autoStartFiredRef.current || countdown !== null) return;

    autoStartFiredRef.current = true;
    session?.freezeLearning();
    setCountdown(3);
    session?.getVoiceCoach().speak('Ready. Starting in three...', true);
  }, [ready, autoStartEnabled, countdown, session]);

  // Countdown timer loop. GO is shown briefly, then cleared so it cannot
  // sit on the camera for the rest of the set.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      session?.getVoiceCoach().speak('Go!', true);
      onStartCountingRef.current();
      const clear = window.setTimeout(() => setCountdown(null), 800);
      return () => window.clearTimeout(clear);
    }

    const timer = window.setTimeout(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        const next = prev - 1;
        if (next === 2) {
          session?.getVoiceCoach().speak('Two', true);
        } else if (next === 1) {
          session?.getVoiceCoach().speak('One', true);
        }
        return next;
      });
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [countdown, session]);

  // Spacebar shortcut: allows quick hands-free trigger
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        (e.target === document.body || (e.target as HTMLElement)?.tagName !== 'INPUT')
      ) {
        e.preventDefault();
        if (countdown === null) {
          setCountdown(3);
          session?.getVoiceCoach().speak('Starting in three...', true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [countdown, session]);

  const poseReady = poseStatus === 'running' || poseStatus === 'ready';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {ready
              ? '✓ Calibration complete'
              : calibPhase === 'MOVEMENT_CALIBRATION'
                ? 'Phase B: Movement calibration'
                : 'Phase A: Camera alignment'}
          </h2>
          <p className="text-xs text-ink-muted">
            {ready
              ? 'Personal range of motion calibrated.'
              : calibPhase === 'MOVEMENT_CALIBRATION'
                ? 'Hold the top position, then do a normal push-up so I can learn your movement.'
                : 'Hold the top of a push-up. Upper body in view is enough.'}
          </p>
        </div>
        <span className="text-xs text-ink-faint">
          {samples > 0 ? `${samples} pose samples` : 'acquiring…'}
          {poseReady && assetSource ? ` · assets: ${assetSource}` : ''}
        </span>
      </div>

      {!poseReady && (
        <p className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
          <Spinner />
          Loading pose model…
        </p>
      )}

      {poseReady && (
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {checks.map((c) => (
            <li key={c.id} className="flex items-start gap-2.5">
              <span
                className={clsx(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                  c.passed ? 'bg-accent text-base' : 'bg-base-border text-ink-faint',
                )}
                aria-hidden="true"
              >
                {c.passed ? '✓' : '·'}
              </span>
              <div className="min-w-0">
                <div
                  className={clsx(
                    'text-sm',
                    c.passed ? 'text-ink' : 'text-ink-muted',
                  )}
                >
                  {c.label}
                </div>
                {!c.passed && c.hint && (
                  <div className="text-xs text-ink-faint">{c.hint}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Movement prompt banner */}
      {poseReady && !ready && (
        <div className="mt-3 rounded-card border border-base-border bg-base-raised p-3">
          <div className="flex items-center justify-between text-xs text-ink">
            <span className="font-medium">Movement Calibration:</span>
            <span className="text-ink-muted">
              {repsDone >= repsNeeded ? 'ROM captured' : `${repsDone} / ${repsNeeded} practice reps`}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {promptMsg || 'Hold the top, then start when you are ready. The first push-up is used, not discarded.'}
          </p>
        </div>
      )}

      {/* Active countdown banner */}
      {countdown !== null && (
        <div className="mt-3 flex items-center justify-between rounded-card border border-accent bg-accent/10 p-3.5 animate-fade-in">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-sm font-bold text-base shadow-sm">
              {countdown > 0 ? countdown : 'GO'}
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">
                {countdown > 0 ? `Starting workout in ${countdown}s (hands-free)` : 'Starting workout now!'}
              </p>
              <p className="text-xs text-ink-muted">
                Get into push-up position — reps will begin counting automatically
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-primary text-xs py-1.5 px-3"
              onClick={() => {
                setCountdown(null);
                onStartCounting();
              }}
            >
              Start now
            </button>
            <button
              className="btn-secondary text-xs py-1.5 px-3"
              onClick={() => {
                setCountdown(null);
                autoStartFiredRef.current = false;
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          onClick={() => {
            setCountdown(null);
            onStartCounting();
          }}
          disabled={!ready && countdown === null}
          aria-describedby={!ready ? 'calib-hint' : undefined}
        >
          {countdown !== null ? 'Start counting now' : 'Start counting'}
        </button>

        {!ready && countdown === null && (
          <button
            className="btn-secondary text-xs"
            onClick={() => {
              setCountdown(3);
              session?.getVoiceCoach().speak('Starting in three...', true);
            }}
            title="Start a 3-second countdown and begin workout without waiting for all checks"
          >
            Skip &amp; start in 3s (hands-free)
          </button>
        )}

        {!ready && countdown === null && (
          <span id="calib-hint" className="text-xs text-ink-muted">
            Do practice reps, tap [Space], or click Skip to start
          </span>
        )}

        {ready && countdown === null && (
          <span className="text-xs text-accent font-medium">
            Ready — auto-start countdown active
          </span>
        )}

        <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoStartEnabled}
            onChange={(e) => setAutoStartEnabled(e.target.checked)}
            className="rounded border-base-border accent-accent"
          />
          Hands-free auto-countdown
        </label>

        {elbowNow !== null && Number.isFinite(elbowNow) && (
          <span className="font-mono text-[11px] text-ink-faint">
            live elbow {formatInt(elbowNow)}°
          </span>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-faint">
        Camera frames are analyzed for pose estimation and are not stored. Press [Space] to quick-start.
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-base-border border-t-accent"
      aria-hidden="true"
    />
  );
}
