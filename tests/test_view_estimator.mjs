/**
 * tests/test_view_estimator.mjs
 *
 * Verifies ViewEstimator:
 * - front / side / diagonal classification
 * - hysteresis prevents flickering
 * - manual override takes precedence
 * - view locking after calibration
 */

import assert from 'node:assert';
import { ViewEstimator, toLegacyCameraView } from '../packages/pose/dist/index.js';

function createDummyLandmarks(type) {
  const lms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));

  // Torso base
  lms[23] = { x: 0.45, y: 0.7, z: 0, visibility: 0.9 }; // L_HIP
  lms[24] = { x: 0.55, y: 0.7, z: 0, visibility: 0.9 }; // R_HIP

  if (type === 'front') {
    // Broad shoulders, balanced visibility, low z disparity
    lms[11] = { x: 0.35, y: 0.3, z: 0.01, visibility: 0.95 }; // L_SHOULDER
    lms[12] = { x: 0.65, y: 0.3, z: 0.02, visibility: 0.95 }; // R_SHOULDER
    lms[13] = { x: 0.25, y: 0.4, z: 0.05, visibility: 0.92 }; // L_ELBOW
    lms[14] = { x: 0.75, y: 0.4, z: 0.05, visibility: 0.92 }; // R_ELBOW
    lms[15] = { x: 0.20, y: 0.6, z: 0.02, visibility: 0.90 }; // L_WRIST
    lms[16] = { x: 0.80, y: 0.6, z: 0.02, visibility: 0.90 }; // R_WRIST
  } else if (type === 'side_left') {
    // Narrow apparent shoulder width, left side high visibility, right side low
    lms[11] = { x: 0.48, y: 0.3, z: -0.1, visibility: 0.98 }; // L_SHOULDER
    lms[12] = { x: 0.52, y: 0.3, z: 0.2, visibility: 0.20 };  // R_SHOULDER (occluded)
    lms[13] = { x: 0.40, y: 0.45, z: -0.1, visibility: 0.95 };
    lms[14] = { x: 0.50, y: 0.45, z: 0.2, visibility: 0.15 };
    lms[15] = { x: 0.35, y: 0.6, z: -0.1, visibility: 0.90 };
    lms[16] = { x: 0.45, y: 0.6, z: 0.2, visibility: 0.10 };
    lms[24] = { x: 0.52, y: 0.7, z: 0.2, visibility: 0.25 }; // R_HIP occluded
  } else if (type === 'diagonal') {
    // Intermediate shoulder width and moderate visibility
    lms[11] = { x: 0.40, y: 0.3, z: -0.05, visibility: 0.90 };
    lms[12] = { x: 0.58, y: 0.3, z: 0.10, visibility: 0.60 };
    lms[13] = { x: 0.32, y: 0.45, z: -0.05, visibility: 0.88 };
    lms[14] = { x: 0.62, y: 0.45, z: 0.10, visibility: 0.55 };
    lms[15] = { x: 0.28, y: 0.6, z: -0.05, visibility: 0.85 };
    lms[16] = { x: 0.65, y: 0.6, z: 0.10, visibility: 0.50 };
  }

  return lms;
}

function runTests() {
  console.log('Testing ViewEstimator...');

  const estimator = new ViewEstimator({ historySize: 5 });

  // 1. Raw estimation on front
  const frontLms = createDummyLandmarks('front');
  const estFront = estimator.estimateRaw(frontLms);
  assert.strictEqual(estFront.view, 'VIEW_FRONT', `Expected VIEW_FRONT, got ${estFront.view}`);
  assert.ok(estFront.confidence >= 0.7, 'Front confidence should be high');
  assert.strictEqual(toLegacyCameraView(estFront.view), 'front');

  // 2. Raw estimation on side
  const sideLms = createDummyLandmarks('side_left');
  const estSide = estimator.estimateRaw(sideLms);
  assert.strictEqual(estSide.view, 'VIEW_SIDE_LEFT', `Expected VIEW_SIDE_LEFT, got ${estSide.view}`);
  assert.ok(estSide.confidence >= 0.7, 'Side confidence should be high');
  assert.strictEqual(toLegacyCameraView(estSide.view), 'side');

  // 3. Raw estimation on diagonal
  const diagLms = createDummyLandmarks('diagonal');
  const estDiag = estimator.estimateRaw(diagLms);
  assert.ok(
    estDiag.view === 'VIEW_DIAGONAL_LEFT' || estDiag.view === 'VIEW_DIAGONAL_RIGHT',
    `Expected diagonal view, got ${estDiag.view}`,
  );
  assert.strictEqual(toLegacyCameraView(estDiag.view), 'diagonal');

  // 4. Hysteresis test: Single noisy frame does not flip stable front view
  estimator.reset();
  for (let i = 0; i < 5; i++) {
    estimator.update(frontLms);
  }
  assert.strictEqual(estimator.update(frontLms).view, 'VIEW_FRONT');

  // One noisy side frame injected
  const resWithNoise = estimator.update(sideLms);
  assert.strictEqual(resWithNoise.view, 'VIEW_FRONT', 'Single noisy frame must not flip view');

  // 5. Manual Override
  estimator.setManualMode('SIDE');
  const manualResult = estimator.update(frontLms);
  assert.ok(
    manualResult.view === 'VIEW_SIDE_LEFT' || manualResult.view === 'VIEW_SIDE_RIGHT',
    `Manual override SIDE must win, got ${manualResult.view}`,
  );
  estimator.setManualMode('FRONT');
  assert.strictEqual(estimator.update(sideLms).view, 'VIEW_FRONT', 'Manual override FRONT must win');

  // Reset manual mode back to AUTO
  estimator.setManualMode('AUTO');

  // 6. View Locking post-calibration
  estimator.reset();
  estimator.update(frontLms);
  estimator.lockView('VIEW_FRONT');
  assert.ok(estimator.isLocked(), 'Estimator should report isLocked=true');
  const lockedResult = estimator.update(sideLms);
  assert.strictEqual(lockedResult.view, 'VIEW_FRONT', 'Locked view must remain VIEW_FRONT even with side input');

  estimator.unlockView();
  assert.strictEqual(estimator.isLocked(), false);

  console.log('ViewEstimator tests PASSED!');
}

runTests();
