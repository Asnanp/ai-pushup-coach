'use client';

/**
 * /lab/live-counter
 *
 * Live benchmark mode. Records derived numerical signals only — never RGB,
 * camera frames, or canvas pixels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraStage, poseBridgeRef, type CameraStageHandle } from '@/components/CameraStage';
import { LiveTraceVisualizer, type TraceSample } from '@/components/LiveTraceVisualizer';
import { CameraEngine, makeCaptureError } from '@/lib/camera';
import { PoseEngine } from '@ai-pushup-coach/pose';
import { V3RepEngine } from '@ai-pushup-coach/rep-counter';
import type { CaptureError, PoseFrame, UserViewMode, V2CameraView } from '@ai-pushup-coach/types';

export default function LiveCounterLabPage() {
  const cameraRef = useRef<CameraEngine | null>(null);
  const poseRef = useRef<PoseEngine | null>(null);
  const stageRef = useRef<CameraStageHandle | null>(null);
  const engineRef = useRef(new V3RepEngine());

  const [error, setError] = useState<CaptureError | null>(null);
  const [running, setRunning] = useState(false);
  const [sample, setSample] = useState<TraceSample | null>(null);
  const [state, setState] = useState('WAITING');
  const [count, setCount] = useState(0);
  const [reject, setReject] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<UserViewMode>('FRONT');
  const [dims, setDims] = useState({ w: 1280, h: 720 });
  const rom = engineRef.current.getRom();

  useEffect(() => {
    const camera = new CameraEngine();
    cameraRef.current = camera;
    return () => {
      poseRef.current?.close();
      void camera.stop();
    };
  }, []);

  const onPose = useCallback((frame: PoseFrame) => {
    const view: V2CameraView =
      viewMode === 'SIDE' ? 'VIEW_SIDE_LEFT' : viewMode === 'DIAGONAL' ? 'VIEW_DIAGONAL_LEFT' : 'VIEW_FRONT';
    const result = engineRef.current.feed({
      timestamp: frame.timestamp,
      landmarks: frame.landmarks,
      worldLandmarks: frame.worldLandmarks,
      view,
      canCount: frame.capability?.canCountRep ?? frame.valid,
    });
    setState(result.fsmState);
    setCount(engineRef.current.getCount());
    setReject(result.rejectionReason);
    setSample({
      t: frame.timestamp,
      leftElbow: result.trace.leftElbow2D,
      rightElbow: result.trace.rightElbow2D,
      fused: result.trace.bilateralFusedAngle,
      worldDepth: result.trace.shoulderWorldZ,
      shoulderDepth: result.trace.shoulderImageMovement,
      phase: result.phase,
      state: result.fsmState,
      top: result.rom.elbowTop,
      bottom: result.rom.elbowBottom,
      rom: result.rom.elbowTop - result.rom.elbowBottom,
    });
  }, [viewMode]);

  const start = useCallback(async () => {
    const camera = cameraRef.current;
    const video = stageRef.current?.getVideo();
    if (!camera || !video) return;
    try {
      await camera.start(video, { width: 1280, height: 720, fps: 30 });
      setDims({ w: video.videoWidth || 1280, h: video.videoHeight || 720 });
      if (!poseRef.current) {
        poseRef.current = new PoseEngine({
          targetFps: 20,
          onFrame: (frame) => {
            poseBridgeRef.current?.(frame);
          },
        });
      }
      const ok = await poseRef.current.init();
      if (!ok) {
        setError(makeCaptureError('MODEL_UNAVAILABLE'));
        return;
      }
      poseRef.current.start(video);
      engineRef.current.reset();
      engineRef.current.startCounting();
      setRunning(true);
      setError(null);
    } catch (err) {
      setError(err as CaptureError);
    }
  }, []);

  const exportJson = () => {
    const json = engineRef.current.traces.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-counter-trace-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-5 py-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-ink-faint">Developer lab</p>
        <h1 className="text-2xl font-semibold text-ink">Live counter benchmark</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Records joint angles, depth, phase, and FSM state only. Video is processed on this
          device and is not stored.
        </p>
      </header>

      {error && (
        <div className="rounded-card border border-danger/40 bg-danger/10 p-3 text-sm text-ink">
          {error.title}: {error.detail}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={() => void start()} disabled={running}>
          {running ? 'Camera running' : 'Start live camera'}
        </button>
        <select
          className="rounded-control border border-base-border bg-base-raised px-3 py-2 text-sm"
          value={viewMode}
          onChange={(e) => setViewMode(e.target.value as UserViewMode)}
        >
          <option value="FRONT">FRONT</option>
          <option value="SIDE">SIDE</option>
          <option value="DIAGONAL">DIAGONAL</option>
          <option value="AUTO">AUTO</option>
        </select>
        <button className="btn-secondary" onClick={exportJson}>
          Export debug JSON
        </button>
        <span className="text-sm text-ink">
          Attempts: <strong>{count}</strong>
        </span>
        {reject && <span className="text-xs text-warn">last reject: {reject}</span>}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CameraStage
          ref={stageRef}
          onPoseFrame={onPose}
          isLive={running}
          videoWidth={dims.w}
          videoHeight={dims.h}
        />
        <LiveTraceVisualizer
          sample={sample}
          state={state}
          top={rom.elbowTop}
          bottom={rom.elbowBottom}
          rom={rom.elbowTop - rom.elbowBottom}
        />
      </div>
    </div>
  );
}
