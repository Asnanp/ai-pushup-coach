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

import { useEffect, useMemo, useState } from 'react';
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
  assetSource?: string | null;
}

export function CalibrationPanel({
  poseStatus,
  session,
  onReady,
  onStartCounting,
  assetSource,
}: Props) {
  const [checks, setChecks] = useState<CalibrationCheck[]>([]);
  const [samples, setSamples] = useState(0);
  const [elbowNow, setElbowNow] = useState<number | null>(null);
  const [calibPhase, setCalibPhase] = useState<CalibrationPhase>('CAMERA_CHECK');
  const [repsDone, setRepsDone] = useState(0);
  const [repsNeeded, setRepsNeeded] = useState(2);
  const [promptMsg, setPromptMsg] = useState('');

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
                ? 'Perform 2 normal push-ups so we can learn your movement range.'
                : 'Position yourself squarely in view of the camera.'}
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
            {promptMsg || 'Perform 2 normal push-ups so we can learn your movement range. Do not hold still.'}
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          className="btn-primary"
          onClick={onStartCounting}
          disabled={!ready}
          aria-describedby={!ready ? 'calib-hint' : undefined}
        >
          Start counting
        </button>

        {!ready && (
          <span id="calib-hint" className="text-xs text-ink-muted">
            Perform practice movement to unlock counting
          </span>
        )}

        {ready && (
          <span className="text-xs text-accent">
            Ready — start your workout when you are
          </span>
        )}

        {elbowNow !== null && Number.isFinite(elbowNow) && (
          <span className="ml-auto font-mono text-[11px] text-ink-faint">
            live elbow {formatInt(elbowNow)}°
          </span>
        )}
      </div>

      <p className="mt-3 text-xs text-ink-faint">
        Camera frames are analyzed for pose estimation and are not stored.
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
