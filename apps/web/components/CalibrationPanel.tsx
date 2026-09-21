'use client';

/**
 * components/CalibrationPanel.tsx
 *
 * Agent 2 (UX) + Agent 5 (camera) + Agent 6 (pose)
 *
 * Pre-workout CAMERA CHECK. Mirrors the spec's checklist:
 *   Full body / Pose detected / Side view / Lighting
 *
 * The panel gates the START COUNTING button on real conditions, and each
 * failing check carries a specific instruction rather than a generic
 * "not ready". Counting must not begin until the conditions hold — otherwise
 * the first reps are scored on bad data.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { CalibrationCheck } from '@ai-pushup-coach/types';
import type { PoseStatus } from '@ai-pushup-coach/pose';
import { WorkoutSession } from '@/lib/workout-session';
import { formatInt } from '@/lib/format';

interface Props {
  poseStatus: PoseStatus;
  session: WorkoutSession | null;
  onReady: (ready: boolean) => void;
  onStartCounting: () => void;
  /**
   * Which `POSE_ASSET_SOURCES` entry the pose runtime actually loaded from —
   * `'local'` means the assets were served from this app, `'cdn'` means the
   * local copies were missing and the network was used. Reported rather than
   * assumed: the whole point of serving the assets locally is that the app
   * runs offline, and a demo operator needs a way to confirm that it did.
   */
  assetSource?: string | null;
}

/**
 * Calibration runs as a polling loop rather than per-frame React updates.
 * It samples the session's own state 5x/second, which is enough to light up a
 * checklist and keeps React out of the pose hot path.
 */
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

  useEffect(() => {
    if (!session) return;
    const id = window.setInterval(() => {
      const s = session.getCalibrationState();
      setChecks(s.checks);
      setSamples(s.samples);
      setElbowNow(s.liveElbowAngle);
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
        <h2 className="text-sm font-semibold text-ink">Camera check</h2>
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
            Waiting for all checks to pass
          </span>
        )}

        {ready && (
          <span className="text-xs text-accent">
            Ready — start your set when you are
          </span>
        )}

        {elbowNow !== null && Number.isFinite(elbowNow) && (
          <span className="ml-auto font-mono text-[11px] text-ink-faint">
            elbow {formatInt(elbowNow)}°
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
