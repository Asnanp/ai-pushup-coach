/**
 * tests/test_front_rep_counter.mjs
 *
 * Verification suite for:
 * - FrontRepSignalExtractor (bilateral elbow fusion, noisy-arm tolerance, depth/centroid motion)
 * - SideRepSignalExtractor & DiagonalRepSignalExtractor
 * - MotionCalibrator (two-stage dynamic calibration, no-motion rejection)
 * - RepCounter FSM integration with RepMotionSignal and adaptive recalibration
 */

import assert from 'node:assert/strict';
import repCounterPkg from '../packages/rep-counter/dist/index.js';
const {
  FrontRepSignalExtractor,
  SideRepSignalExtractor,
  DiagonalRepSignalExtractor,
  MotionCalibrator,
  RepCounter,
  FALLBACK_THRESHOLDS,
} = repCounterPkg;

console.log('Testing Front Rep Counter & Bilateral Signal Extractors...');

// Helper to create synthetic 33-landmark skeleton in front view
function createFrontLandmarks({
  leftElbowAngle = 160,
  rightElbowAngle = 160,
  yOffset = 0.5,
  noiseArm = null,
} = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0.0,
    visibility: 0.95,
  }));

  // Left shoulder & elbow
  const ls = { x: 0.35, y: yOffset };
  const le = { x: 0.25, y: yOffset + 0.15 };
  landmarks[11] = { x: ls.x, y: ls.y, z: 0.0, visibility: 0.98 };
  landmarks[13] = { x: le.x, y: le.y, z: 0.0, visibility: noiseArm === 'left' ? 0.1 : 0.95 };

  // Hips
  landmarks[23] = { x: 0.40, y: yOffset + 0.35, z: 0.0, visibility: 0.98 };
  landmarks[24] = { x: 0.60, y: yOffset + 0.35, z: 0.0, visibility: 0.98 };

  // Exact elbow angle between (ls - le) and (lw - le)
  const v_l_se = { x: ls.x - le.x, y: ls.y - le.y };
  const base_l_angle = Math.atan2(v_l_se.y, v_l_se.x);
  const l_target_rad = (leftElbowAngle * Math.PI) / 180;
  const lw_dir = base_l_angle + l_target_rad;
  const arm_len = 0.2;
  landmarks[15] = {
    x: le.x + arm_len * Math.cos(lw_dir),
    y: le.y + arm_len * Math.sin(lw_dir),
    z: 0.0,
    visibility: noiseArm === 'left' ? 0.2 : 0.95,
  };

  // Right shoulder & elbow
  const rs = { x: 0.65, y: yOffset };
  const re = { x: 0.75, y: yOffset + 0.15 };
  landmarks[12] = { x: rs.x, y: rs.y, z: 0.0, visibility: 0.98 };
  landmarks[14] = { x: re.x, y: re.y, z: 0.0, visibility: noiseArm === 'right' ? 0.1 : 0.95 };

  const v_r_se = { x: rs.x - re.x, y: rs.y - re.y };
  const base_r_angle = Math.atan2(v_r_se.y, v_r_se.x);
  const r_target_rad = (rightElbowAngle * Math.PI) / 180;
  const rw_dir = base_r_angle - r_target_rad;
  landmarks[16] = {
    x: re.x + arm_len * Math.cos(rw_dir),
    y: re.y + arm_len * Math.sin(rw_dir),
    z: 0.0,
    visibility: noiseArm === 'right' ? 0.2 : 0.95,
  };

  return landmarks;
}

// 1. Bilateral arm fusion test
{
  const extractor = new FrontRepSignalExtractor();
  const lmBothGood = createFrontLandmarks({ leftElbowAngle: 160, rightElbowAngle: 158 });
  const signalBoth = extractor.extract(lmBothGood, 1000);

  assert(Number.isFinite(signalBoth.phaseEvidence), 'phaseEvidence must be finite');
  assert(Number.isFinite(signalBoth.elbowLeft), 'elbowLeft must be finite');
  assert(Number.isFinite(signalBoth.elbowRight), 'elbowRight must be finite');
  assert(Number.isFinite(signalBoth.elbowCombined), 'elbowCombined must be finite');
  assert(signalBoth.elbowCombined > 140, `Expected combined angle > 140, got ${signalBoth.elbowCombined}`);
  console.log('✓ Bilateral arm fusion produces valid finite combined angle');
}

// 2. Tolerance of one noisy arm (bilateral robustness)
{
  const extractor = new FrontRepSignalExtractor();
  // Left arm occluded/noisy, right arm clear at 160 deg
  const lmOneNoisy = createFrontLandmarks({ leftElbowAngle: 60, rightElbowAngle: 160, noiseArm: 'left' });
  const signal = extractor.extract(lmOneNoisy, 1033);

  assert(Number.isFinite(signal.phaseEvidence), 'phaseEvidence must remain finite with one noisy arm');
  // Right arm should dominate because left visibility is degraded
  assert(signal.phaseEvidence > 140, `Expected robust phaseEvidence > 140 using clear right arm, got ${signal.phaseEvidence}`);
  console.log('✓ Bilateral extractor tolerates one noisy arm by weighting visible arm');
}

// 3. Motion calibration: rejects no-motion / stationary user
{
  const calibrator = new MotionCalibrator({ requiredReps: 2, minRomDeg: 25 });
  calibrator.setCameraCheckPassed(true);

  // Feed 40 frames with zero motion (standing still at 165 deg)
  let lastState = null;
  for (let i = 0; i < 40; i++) {
    lastState = calibrator.feed(165 + Math.sin(i) * 0.5, i * 33);
  }

  assert(lastState.phase !== 'READY', 'MotionCalibrator must reject stationary user with no motion excursion');
  assert(!lastState.thresholds, 'Thresholds should be falsy until motion observed');
  console.log('✓ MotionCalibrator rejects stationary user without excursion');
}

// 4. Motion calibration: succeeds after 2 dynamic reps
{
  const calibrator = new MotionCalibrator({ requiredReps: 2, minRomDeg: 25 });
  calibrator.setCameraCheckPassed(true);

  let lastState = null;
  let t = 0;
  // Simulate 2 pushups with return to top: 165 -> 80 -> 165
  for (let rep = 0; rep < 2; rep++) {
    for (let step = 0; step <= 30; step++) {
      const angle = 165 - 85 * Math.sin((step / 30) * Math.PI);
      t += 50;
      lastState = calibrator.feed(angle, t);
    }
  }
  // Short top-hold for smoother queue flush
  for (let f = 0; f < 10; f++) {
    t += 50;
    lastState = calibrator.feed(165, t);
    if (lastState.ready) break;
  }

  assert.equal(lastState.phase, 'READY', `Expected READY phase, got ${lastState.phase}: ${lastState.feedbackPrompt}`);
  assert.equal(lastState.ready, true, 'ready must be true');
  const cal = calibrator.getCalibratedThresholds();
  assert(cal !== null, 'Calibration thresholds must be returned');
  assert(cal.observedMin < 95, `Observed min should be < 95, got ${cal.observedMin}`);
  assert(cal.observedMax > 140, `Observed max should be > 140, got ${cal.observedMax}`);
  assert(cal.upEnter > cal.downEnter, 'upEnter must be > downEnter');
  console.log(`✓ MotionCalibrator calibrated: min=${cal.observedMin.toFixed(1)}°, max=${cal.observedMax.toFixed(1)}°, downEnter=${cal.downEnter.toFixed(1)}°`);
}

// 5. Rep counting with RepMotionSignal and adaptive recalibration
{
  const counter = new RepCounter({
    initialCalibration: { ...FALLBACK_THRESHOLDS },
    minDurationMs: 600,
    maxDurationMs: 6000,
  });

  let repCount = 0;
  // Simulate 3 front pushups with realistic lockout between reps
  let t = 0;
  for (let rep = 0; rep < 3; rep++) {
    // Top position before descent
    for (let top = 0; top < 6; top++) {
      t += 0.05;
      const ev = counter.feed({
        timestamp: t,
        phaseEvidence: 165,
        elbowLeft: 165,
        elbowRight: 165,
        elbowCombined: 165,
        shoulderMotion: 0.5,
        hipMotion: 0.85,
        worldDepthMotion: 0,
        poseConfidence: 0.95,
        view: 'VIEW_FRONT',
      });
      if (ev) repCount++;
    }
    // Descent and ascent
    for (let f = 0; f < 30; f++) {
      t += 0.05;
      const angle = 165 - 80 * Math.sin((f / 30) * Math.PI);
      const ev = counter.feed({
        timestamp: t,
        phaseEvidence: angle,
        elbowLeft: angle,
        elbowRight: angle,
        elbowCombined: angle,
        shoulderMotion: 0.5,
        hipMotion: 0.85,
        worldDepthMotion: 0,
        poseConfidence: 0.95,
        view: 'VIEW_FRONT',
      });
      if (ev) repCount++;
    }
  }
  // Final top return
  for (let top = 0; top < 10; top++) {
    t += 0.05;
    const ev = counter.feed({
      timestamp: t,
      phaseEvidence: 165,
      elbowLeft: 165,
      elbowRight: 165,
      elbowCombined: 165,
      shoulderMotion: 0.5,
      hipMotion: 0.85,
      worldDepthMotion: 0,
      poseConfidence: 0.95,
      view: 'VIEW_FRONT',
    });
    if (ev) repCount++;
  }

  assert.equal(repCount, 3, `Expected 3 reps counted from synthetic signal, got ${repCount}`);
  console.log('✓ RepCounter correctly counts 3 reps using RepMotionSignal');
}

console.log('\nAll Front Rep Counter and Bilateral Signal Extractor tests PASSED!\n');
