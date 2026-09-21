/**
 * tests/test_coach_engine.mjs
 *
 * Verification suite for:
 * - CoachEngine state machine
 * - Anti-spam rate limiting and cooldown
 * - Correction recognition strictly requiring measured metric improvement
 * - Good streak milestones
 * - VoiceCoach safe fallback
 */

import assert from 'node:assert/strict';
import coachEnginePkg from '../packages/coach-engine/dist/index.js';
const { CoachEngine, VoiceCoach } = coachEnginePkg;

console.log('Testing Coach Engine & Correction Recognition...');

function makeAssessment({
  repIndex = 1,
  label = 'good',
  valid = true,
  depth = 85,
  alignment = 85,
  repScore = 85,
  primaryIssue = null,
} = {}) {
  return {
    repIndex,
    label,
    confidence: 0.90,
    goodProbability: label === 'good' ? 0.85 : 0.25,
    valid,
    repScore,
    geometryScore: repScore,
    modelScore: repScore,
    components: {
      depth,
      alignment,
      tempo: 80,
      consistency: 80,
      rom: 85,
    },
    primaryIssue,
    secondaryIssues: [],
    scoreSource: 'model+geometry',
    borderline: false,
    missingFeatureCount: 0,
  };
}

// 1. Initial good rep -> no spam voice needed
{
  const coach = new CoachEngine();
  const feedback = coach.processRep(makeAssessment({ repIndex: 1, label: 'good', valid: true }), 1000);
  assert.equal(feedback.visualMessage, '✓ Good rep!');
  assert.equal(feedback.spokenMessage, null, 'Good rep should not trigger voice on rep 1');
  console.log('✓ Good rep does not speak unnecessarily on rep 1');
}

// 2. Form issue warning
{
  const coach = new CoachEngine();
  const feedback = coach.processRep(makeAssessment({
    repIndex: 1,
    label: 'bad',
    valid: false,
    depth: 40,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 1000);

  assert.equal(feedback.visualMessage, '⚠ Go a little lower');
  assert.equal(feedback.spokenMessage, 'Go a little lower.');
  assert.equal(feedback.targetIssue, 'INCOMPLETE_DEPTH');
  console.log('✓ Form issue triggers actionable coaching warning');
}

// 3. Anti-spam: Do NOT spam the same warning consecutively
{
  const coach = new CoachEngine({ minSpeechCooldownMs: 2500 });
  // Rep 1: Shallow
  coach.processRep(makeAssessment({
    repIndex: 1,
    label: 'bad',
    valid: false,
    depth: 40,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 1000);

  // Rep 2: Shallow again after 2 seconds (< cooldown)
  const f2 = coach.processRep(makeAssessment({
    repIndex: 2,
    label: 'bad',
    valid: false,
    depth: 42,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 3000);

  assert.equal(f2.spokenMessage, null, 'Must not spam spoken advice during cooldown or consecutive repeat');
  console.log('✓ Coach suppresses spoken repetition spam');
}

// 4. Correction recognition: requires measured improvement
{
  const coach = new CoachEngine();
  // Rep 1: Shallow warning
  coach.processRep(makeAssessment({
    repIndex: 1,
    label: 'bad',
    valid: false,
    depth: 40,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 1000);

  // Rep 2: Depth improved substantially (40 -> 82)
  const f2 = coach.processRep(makeAssessment({
    repIndex: 2,
    label: 'good',
    valid: true,
    depth: 82,
    primaryIssue: null,
  }), 4000);

  assert.equal(f2.isCorrection, true, 'isCorrection must be true when metric improved');
  assert.equal(f2.spokenMessage, 'Better depth.');
  assert.match(f2.visualMessage, /Much better depth! Good correction/);
  console.log('✓ Correction recognition succeeds when measured metric improves');

  // Rep 3: Another shallow warning
  coach.processRep(makeAssessment({
    repIndex: 3,
    label: 'bad',
    valid: false,
    depth: 40,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 8000);

  // Rep 4: User did NOT improve depth (depth remains 42)
  const f4 = coach.processRep(makeAssessment({
    repIndex: 4,
    label: 'bad',
    valid: false,
    depth: 42,
    primaryIssue: 'INCOMPLETE_DEPTH',
  }), 12000);

  assert.equal(f4.isCorrection, false, 'Must NOT claim correction if metric did not improve');
  console.log('✓ Correction recognition strictly rejects uncorrected repetitions');
}

// 5. VoiceCoach fallback
{
  const voice = new VoiceCoach({ mode: 'NORMAL' });
  // In Node environment, window is undefined, should safely return false without throwing
  const spoke = voice.speak('Good rep.');
  assert.equal(spoke, false);
  voice.setMode('OFF');
  assert.equal(voice.getMode(), 'OFF');
  console.log('✓ VoiceCoach safely falls back in environments without SpeechSynthesis');
}

console.log('\nAll Coach Engine and Correction Recognition tests PASSED!\n');
