/**
 * V3 live-first motion engine tests.
 *
 * Encodes the real missed-rep failure modes: weak front 2D elbow, landmark
 * collapse, tremor, and the 3D-angle z-component bug.
 */
import { describe, expect, it } from 'vitest';

import type { Landmark } from '@ai-pushup-coach/types';
import { angleDeg3D } from '@ai-pushup-coach/biomechanics';
import {
  V3RepEngine,
  matchRepEvents,
  maskImplausibleAngle,
  extractRichMotion,
} from '@ai-pushup-coach/rep-counter';

const FPS = 20;

function lm(x: number, y: number, z = 0, visibility = 1): Landmark {
  return { x, y, z, visibility };
}

function skeleton(opts: {
  elbowDeg?: number;
  shoulderY?: number;
  shoulderZ?: number;
  wristDist?: number;
  leftVis?: number;
  rightVis?: number;
}): Landmark[] {
  const deg = opts.elbowDeg ?? 160;
  const shY = opts.shoulderY ?? 0.42;
  const shZ = opts.shoulderZ ?? 0;
  const dist = opts.wristDist ?? 0.22;
  const lv = opts.leftVis ?? 0.95;
  const rv = opts.rightVis ?? 0.95;
  const lms = Array.from({ length: 33 }, () => lm(0.5, 0.5, 0, 0.9));

  lms[11] = lm(0.38, shY, shZ, lv);
  lms[12] = lm(0.62, shY, shZ, rv);
  lms[13] = lm(0.32, shY + 0.12, shZ, lv);
  lms[14] = lm(0.68, shY + 0.12, shZ, rv);
  lms[23] = lm(0.42, shY + 0.32, shZ * 0.4, 0.9);
  lms[24] = lm(0.58, shY + 0.32, shZ * 0.4, 0.9);

  const rad = (deg * Math.PI) / 180;
  const r = dist;
  lms[15] = lm(lms[13].x + r * Math.sin(rad), lms[13].y - r * Math.cos(rad), shZ, lv);
  lms[16] = lm(lms[14].x + r * Math.sin(rad), lms[14].y - r * Math.cos(rad), shZ, rv);
  return lms;
}

function driveReps(
  engine: V3RepEngine,
  n: number,
  opts: {
    top?: number;
    bottom?: number;
    frames?: number;
    view?: 'VIEW_FRONT' | 'VIEW_SIDE_LEFT';
    yTravel?: number;
    zTravel?: number;
    distTravel?: number;
    elbowTravel?: boolean;
  } = {},
): number {
  const top = opts.top ?? 168;
  const bottom = opts.bottom ?? 90;
  const frames = opts.frames ?? 36;
  const view = opts.view ?? 'VIEW_SIDE_LEFT';
  let t = 0;
  let counted = 0;

  for (let i = 0; i < 12; i++) {
    const r = engine.feed({
      timestamp: t,
      landmarks: skeleton({ elbowDeg: top, shoulderY: 0.4, shoulderZ: 0, wristDist: 0.24 }),
      view,
    });
    if (r.event?.counted) counted += 1;
    t += 1 / FPS;
  }

  for (let c = 0; c < n; c++) {
    for (let i = 0; i < frames; i++) {
      const frac = i / frames;
      const wave = frac < 0.5 ? frac / 0.5 : 1 - (frac - 0.5) / 0.5;
      const elbow = opts.elbowTravel === false ? top : top + (bottom - top) * wave;
      const y = 0.4 + (opts.yTravel ?? 0) * wave;
      const z = 0 + (opts.zTravel ?? 0) * wave;
      const dist = 0.24 - (opts.distTravel ?? 0) * wave;
      const r = engine.feed({
        timestamp: t,
        landmarks: skeleton({ elbowDeg: elbow, shoulderY: y, shoulderZ: z, wristDist: dist }),
        view,
      });
      if (r.event?.counted) counted += 1;
      t += 1 / FPS;
    }
  }

  for (let i = 0; i < 14; i++) {
    const r = engine.feed({
      timestamp: t,
      landmarks: skeleton({ elbowDeg: top, shoulderY: 0.4, shoulderZ: 0, wristDist: 0.24 }),
      view,
    });
    if (r.event?.counted) counted += 1;
    t += 1 / FPS;
  }
  return counted;
}

describe('angleDeg3D', () => {
  it('does not ignore wrist-elbow z (the live front-camera bug)', () => {
    // Front-view flexion: wrist moves primarily in Z. Zeroing bc.z (the old
    // `c.z - c.z` bug) makes the wrist-elbow vector vanish.
    const shoulder = lm(0, 1, 0);
    const elbow = lm(0, 0, 0);
    const wristTowardCamera = lm(0, 0, 1);
    const ang = angleDeg3D(shoulder, elbow, wristTowardCamera);
    expect(ang).toBeCloseTo(90, 4);
  });

  it('uses b.z on both limbs so (c.z - c.z) cannot happen', () => {
    const a = lm(0, 0, 1);
    const b = lm(0, 0, 0);
    const c = lm(0, 1, 1);
    const ang = angleDeg3D(a, b, c);
    expect(Number.isFinite(ang)).toBe(true);
    expect(ang).toBeGreaterThan(40);
    expect(ang).toBeLessThan(90);
  });
});

describe('extractRichMotion', () => {
  it('fills 3D elbow channels from world landmarks', () => {
    const image = skeleton({ elbowDeg: 160 });
    const world = skeleton({ elbowDeg: 90 });
    world.forEach((p) => {
      p.z = 0.15;
    });
    const sig = extractRichMotion(image, 0, 'VIEW_FRONT', world);
    expect(Number.isFinite(sig.elbowLeft3D)).toBe(true);
    expect(Number.isFinite(sig.shoulderWorldZ)).toBe(true);
    expect(Number.isFinite(sig.shoulderWristDist)).toBe(true);
  });
});

describe('V3RepEngine', () => {
  it('counts a clean side-view set', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(168, 90);
    engine.startCounting();
    const n = driveReps(engine, 5);
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('counts front-view reps when 2D elbow is weak but depth and centroid move', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(160, 140);
    engine.startCounting();
    const n = driveReps(engine, 8, {
      view: 'VIEW_FRONT',
      top: 158,
      bottom: 148,
      elbowTravel: true,
      yTravel: 0.16,
      zTravel: 0.12,
      distTravel: 0.1,
      frames: 40,
    });
    expect(n).toBeGreaterThanOrEqual(7);
  });

  it('counts a compressed front 105–150° band like the live workout fixture', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(150, 105);
    engine.startCounting();
    const n = driveReps(engine, 3, {
      view: 'VIEW_FRONT',
      top: 148,
      bottom: 105,
      frames: 26,
      elbowTravel: true,
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('still counts a shallow attempt instead of dropping it', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(165, 70);
    engine.startCounting();
    const n = driveReps(engine, 4, { top: 160, bottom: 118, frames: 32 });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('does not count tremor / micro-motion', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(165, 80);
    engine.startCounting();
    let t = 0;
    let n = 0;
    for (let i = 0; i < 80; i++) {
      const deg = 158 + 3 * Math.sin(i / 2);
      const r = engine.feed({
        timestamp: t,
        landmarks: skeleton({ elbowDeg: deg }),
        view: 'VIEW_SIDE_LEFT',
      });
      if (r.event?.counted) n += 1;
      t += 1 / FPS;
    }
    expect(n).toBe(0);
  });

  it('rejects a collapsed 14° spike without creating a rep', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(165, 85);
    engine.startCounting();
    let t = 0;
    const seq = [162, 158, 153, 14, 149, 145, 150, 155, 160];
    let n = 0;
    for (const deg of seq) {
      const r = engine.feed({
        timestamp: t,
        landmarks: skeleton({ elbowDeg: deg }),
        view: 'VIEW_SIDE_LEFT',
      });
      if (r.event?.counted) n += 1;
      t += 1 / FPS;
    }
    expect(n).toBe(0);
    expect(maskImplausibleAngle(14)).toBeNaN();
  });

  it('bridges a 3-frame wrist dropout mid-descent', () => {
    const engine = new V3RepEngine();
    engine.seedElbowRom(168, 90);
    engine.startCounting();
    let t = 0;
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const r = engine.feed({
        timestamp: t,
        landmarks: skeleton({ elbowDeg: 168 }),
        view: 'VIEW_SIDE_LEFT',
      });
      if (r.event?.counted) n += 1;
      t += 1 / FPS;
    }
    const frames = 40;
    for (let i = 0; i < frames; i++) {
      const frac = i / frames;
      const wave = frac < 0.5 ? frac / 0.5 : 1 - (frac - 0.5) / 0.5;
      const elbow = 168 + (90 - 168) * wave;
      const drop = i >= 10 && i <= 12;
      const r = engine.feed({
        timestamp: t,
        landmarks: drop
          ? skeleton({ elbowDeg: elbow, leftVis: 0.05, rightVis: 0.05 })
          : skeleton({ elbowDeg: elbow }),
        view: 'VIEW_SIDE_LEFT',
        canCount: !drop,
      });
      if (r.event?.counted) n += 1;
      t += 1 / FPS;
    }
    for (let i = 0; i < 14; i++) {
      const r = engine.feed({
        timestamp: t,
        landmarks: skeleton({ elbowDeg: 168 }),
        view: 'VIEW_SIDE_LEFT',
      });
      if (r.event?.counted) n += 1;
      t += 1 / FPS;
    }
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('matchRepEvents', () => {
  it('scores overlap, not raw totals', () => {
    const truth = [
      { start: 0, bottom: 0.5, end: 1 },
      { start: 1.1, bottom: 1.6, end: 2.1 },
      { start: 2.2, bottom: 2.7, end: 3.2 },
    ];
    const detected = [
      { start: 0.05, bottom: 0.55, end: 1.05 },
      { start: 1.05, bottom: 1.55, end: 2.05 },
      { start: 4, bottom: 4.4, end: 4.8 },
    ];
    const report = matchRepEvents(truth, detected);
    expect(report.tp).toBe(2);
    expect(report.fp).toBe(1);
    expect(report.fn).toBe(1);
    expect(report.precision).toBeCloseTo(2 / 3, 5);
    expect(report.recall).toBeCloseTo(2 / 3, 5);
  });
});
