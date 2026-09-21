import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guards for the pose -> session wiring.
 *
 * Why a source check instead of a behavioural test:
 *
 * This bug produced no error, no warning and no visible symptom. CameraStage
 * owns the module-level `poseBridgeRef` and publishes its own internal handler
 * there, so that ref carries frames INTO the stage. The way back out is the
 * `onPoseFrame` prop, and both pages passed `() => {}`.
 *
 * The result: the skeleton overlay animated correctly, the camera preview looked
 * healthy, the timer ran — but frames never reached WorkoutSession, so the rep
 * counter never advanced and every metric stayed at `--` forever. Rendering
 * these pages needs a real webcam and MediaStream, so a behavioural test is not
 * practical. A structural assertion is the only cheap way to stop the wiring
 * from silently regressing again.
 *
 * If this test fails, check the `onPoseFrame` prop on `<CameraStage>`: it must
 * forward to `sessionRef.current`, not be an empty function.
 */

const APP_DIR = path.resolve(__dirname, '..', '..', 'app');

/** Pages that mount a camera and drive a WorkoutSession. */
const CAMERA_PAGES = ['workout/page.tsx', 'challenge/page.tsx'];

describe('pose frame wiring', () => {
  for (const page of CAMERA_PAGES) {
    it(`${page} forwards pose frames to the session`, () => {
      const source = readFileSync(path.join(APP_DIR, page), 'utf8');

      expect(source).toContain('onPoseFrame');

      // An empty arrow function as the prop is the exact defect.
      expect(source).not.toMatch(/onPoseFrame=\{\(\)\s*=>\s*\{\s*\}\}/);
      expect(source).not.toMatch(/onPoseFrame=\{\(\)\s*=>\s*\{\s*\/\*/);

      // It must actually reach the session instance.
      expect(source).toMatch(/onPoseFrame=\{[\s\S]{0,200}?sessionRef\.current\?\.onPoseFrame/);
    });
  }

  it('does not leave the GO overlay up for the whole workout', () => {
    const source = readFileSync(path.join(APP_DIR, 'workout/page.tsx'), 'utf8');
    expect(source).toMatch(/elapsedSeconds/);
    expect(source).toMatch(/setCountdown\(null\)/);
    expect(source).toContain('Begin Push-Ups!');
  });

  it('WorkoutSession exposes onPoseFrame as the documented entry point', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', 'workout-session.ts'),
      'utf8',
    );
    expect(source).toMatch(/onPoseFrame\(pose:\s*PoseFrame\)/);
  });
});

/**
 * The offline-capability claim depends on two links that are each one line long
 * and each invisible at runtime if broken:
 *
 *   1. `PoseEngine.getAssetSource()` must be read after `init()` — otherwise the
 *      engine records which source won and nobody ever sees it.
 *   2. That value must reach `CalibrationPanel` — otherwise the operator has no
 *      way to confirm the offline path engaged short of pulling the network
 *      cable and guessing.
 *
 * A missing link degrades to "the app still works, you just can't prove it",
 * which is exactly the class of failure that survives a demo and then fails at
 * the venue. Asserted structurally because rendering the page needs a webcam.
 */
describe('offline asset-source reporting', () => {
  const POSE_ENGINE = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'pose',
    'src',
    'pose-engine.ts',
  );

  it('PoseEngine records and exposes the source that served the model', () => {
    const source = readFileSync(POSE_ENGINE, 'utf8');
    expect(source).toMatch(/getAssetSource\(\):\s*string \| null/);
    expect(source).toMatch(/this\.assetSource = source\.label/);
    // Local must be tried before the CDN, or "offline" is decorative.
    expect(source).toMatch(
      /POSE_ASSET_SOURCES = \[\s*\{[^}]*label: 'local'[\s\S]*?label: 'cdn'/,
    );
  });

  it('workout page reads the asset source and passes it to the camera check', () => {
    const source = readFileSync(path.join(APP_DIR, 'workout', 'page.tsx'), 'utf8');
    expect(source).toMatch(/setAssetSource\(engine\.getAssetSource\(\)\)/);
    expect(source).toMatch(/assetSource=\{assetSource\}/);
  });

  it('CalibrationPanel renders the asset source when the pose model is ready', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', '..', 'components', 'CalibrationPanel.tsx'),
      'utf8',
    );
    expect(source).toMatch(/assetSource\?:/);
    expect(source).toMatch(/poseReady && assetSource/);
  });
});
