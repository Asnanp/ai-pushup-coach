/**
 * packages/coach-engine/src/coach-engine.ts
 *
 * Agent 13 — COACH ENGINEER & Agent 14 — VOICE ENGINEER
 *
 * Deterministic AI coaching state machine:
 * - Anti-spam rate limiting and hysteresis
 * - Correction recognition based strictly on measured metric delta
 * - Milestone encouragement and form trend tracking
 */

import type { IssueCode, RepAssessment } from '@ai-pushup-coach/types';

export interface PendingCorrection {
  targetIssue: IssueCode;
  baselineMetric: number;
  repIndex: number;
}

export interface CoachingFeedback {
  repIndex: number;
  visualMessage: string;
  message?: string;
  spokenMessage: string | null;
  isCorrection: boolean;
  targetIssue: IssueCode | null;
  priority: 'low' | 'normal' | 'high';
}

export type CoachAction = CoachingFeedback;

export interface CoachEngineOptions {
  minSpeechCooldownMs?: number;
  goodStreakInterval?: number;
}

export class CoachEngine {
  private lastIssue: IssueCode | null = null;
  private issueStreak = 0;
  private lastSpokenIssue: IssueCode | null = null;
  private lastSpokenAt = -100000;
  private previousAssessment: RepAssessment | null = null;
  private pendingCorrection: PendingCorrection | null = null;
  private goodStreak = 0;
  private totalValidReps = 0;

  private recentFormScores: number[] = [];
  private recentDepthScores: number[] = [];
  private recentAlignmentScores: number[] = [];

  private readonly cooldownMs: number;
  private readonly streakInterval: number;

  constructor(opts: CoachEngineOptions = {}) {
    this.cooldownMs = opts.minSpeechCooldownMs ?? 2500;
    this.streakInterval = opts.goodStreakInterval ?? 5;
  }

  reset(): void {
    this.lastIssue = null;
    this.issueStreak = 0;
    this.lastSpokenIssue = null;
    this.lastSpokenAt = 0;
    this.previousAssessment = null;
    this.pendingCorrection = null;
    this.goodStreak = 0;
    this.totalValidReps = 0;
    this.recentFormScores = [];
    this.recentDepthScores = [];
    this.recentAlignmentScores = [];
  }

  processRep(assessment: RepAssessment, timestampMs = Date.now()): CoachingFeedback {
    const repIndex = assessment.repIndex;
    const depth = assessment.components.depth;
    const align = assessment.components.alignment;
    const form = assessment.repScore;

    this.recentFormScores.push(form);
    this.recentDepthScores.push(depth);
    this.recentAlignmentScores.push(align);
    if (this.recentFormScores.length > 5) this.recentFormScores.shift();
    if (this.recentDepthScores.length > 5) this.recentDepthScores.shift();
    if (this.recentAlignmentScores.length > 5) this.recentAlignmentScores.shift();

    let visualMsg = 'Good rep!';
    let spokenMsg: string | null = null;
    let isCorrection = false;
    let targetIssue: IssueCode | null = null;

    // 1. Check for correction recognition on prior warning
    if (this.pendingCorrection) {
      const { targetIssue: pendingIssue, baselineMetric } = this.pendingCorrection;
      let currentMetric = 0;

      if (pendingIssue === 'INCOMPLETE_DEPTH') currentMetric = depth;
      else if (pendingIssue === 'HIPS_TOO_HIGH' || pendingIssue === 'HIPS_DROPPING' || pendingIssue === 'BODY_NOT_STRAIGHT') {
        currentMetric = align;
      }

      // Metric improved by at least 20 points
      const improvement = currentMetric - baselineMetric;
      if (improvement >= 20 && assessment.primaryIssue !== pendingIssue) {
        isCorrection = true;
        targetIssue = pendingIssue;
        this.pendingCorrection = null;

        if (pendingIssue === 'INCOMPLETE_DEPTH') {
          visualMsg = '✓ Much better depth! Good correction.';
          spokenMsg = 'Better depth.';
        } else {
          visualMsg = '✓ Better alignment! Good correction.';
          spokenMsg = 'Much better alignment.';
        }

        this.lastSpokenAt = timestampMs;
        this.lastSpokenIssue = null;
        if (assessment.valid) {
          this.goodStreak++;
          this.totalValidReps++;
        }

        return {
          repIndex,
          visualMessage: visualMsg,
          message: visualMsg,
          spokenMessage: spokenMsg,
          isCorrection: true,
          targetIssue,
          priority: 'high',
        };
      }
    }

    // 2. Process good rep vs form issue
    if (assessment.valid && assessment.label === 'good') {
      this.goodStreak++;
      this.totalValidReps++;
      this.issueStreak = 0;
      this.lastIssue = null;
      this.pendingCorrection = null;

      visualMsg = '✓ Good rep!';

      // Milestone praise at streak intervals
      const timeSinceSpeech = timestampMs - this.lastSpokenAt;
      if (this.goodStreak === 3 && timeSinceSpeech > this.cooldownMs) {
        spokenMsg = 'Great form, keep it up.';
        this.lastSpokenAt = timestampMs;
      } else if (this.totalValidReps > 0 && this.totalValidReps % this.streakInterval === 0 && timeSinceSpeech > this.cooldownMs) {
        spokenMsg = `${this.totalValidReps} valid reps.`;
        this.lastSpokenAt = timestampMs;
      }
    } else if (assessment.label === 'unknown') {
      visualMsg = '? Form uncertain — keep body in view';
      spokenMsg = null;
    } else {
      // Bad form rep with geometric issue
      this.goodStreak = 0;
      const issue = assessment.primaryIssue ?? 'INCOMPLETE_DEPTH';
      targetIssue = issue;

      if (issue === this.lastIssue) {
        this.issueStreak++;
      } else {
        this.issueStreak = 1;
        this.lastIssue = issue;
      }

      // Formulate visual and spoken advice
      switch (issue) {
        case 'INCOMPLETE_DEPTH':
          visualMsg = '⚠ Go a little lower';
          spokenMsg = 'Go a little lower.';
          this.pendingCorrection = {
            targetIssue: 'INCOMPLETE_DEPTH',
            baselineMetric: depth,
            repIndex,
          };
          break;

        case 'HIPS_TOO_HIGH':
          visualMsg = '⚠ Lower your hips, stay aligned';
          spokenMsg = 'Keep your hips aligned.';
          this.pendingCorrection = {
            targetIssue: 'HIPS_TOO_HIGH',
            baselineMetric: align,
            repIndex,
          };
          break;

        case 'HIPS_DROPPING':
          visualMsg = '⚠ Keep your core tight, do not sag';
          spokenMsg = 'Keep your body straight.';
          this.pendingCorrection = {
            targetIssue: 'HIPS_DROPPING',
            baselineMetric: align,
            repIndex,
          };
          break;

        case 'BODY_NOT_STRAIGHT':
          visualMsg = '⚠ Straighten your body line';
          spokenMsg = 'Keep your body straight.';
          this.pendingCorrection = {
            targetIssue: 'BODY_NOT_STRAIGHT',
            baselineMetric: align,
            repIndex,
          };
          break;

        case 'PARTIAL_RANGE':
          visualMsg = '⚠ Extend arms fully at top';
          spokenMsg = 'Complete the lockout.';
          break;

        case 'TOO_FAST':
          visualMsg = '⚠ Slow down your tempo';
          spokenMsg = 'Control your tempo.';
          break;

        default:
          visualMsg = '⚠ Watch your push-up form';
          spokenMsg = null;
          break;
      }

      // Anti-spam filter: do NOT spam the same spoken advice every consecutive rep
      const timeSinceSpeech = timestampMs - this.lastSpokenAt;
      if (this.lastSpokenIssue === issue && this.issueStreak > 1 && timeSinceSpeech < 5000) {
        spokenMsg = null; // Suppress repetitive speech
      } else if (timeSinceSpeech < this.cooldownMs) {
        spokenMsg = null; // Enforce minimum cooldown
      } else if (spokenMsg) {
        this.lastSpokenAt = timestampMs;
        this.lastSpokenIssue = issue;
      }
    }

    this.previousAssessment = assessment;

    return {
      repIndex,
      visualMessage: visualMsg,
      message: visualMsg,
      spokenMessage: spokenMsg,
      isCorrection: false,
      targetIssue,
      priority: 'normal',
    };
  }

  onRepCompleted(assessment: RepAssessment, timestampMs?: number): CoachingFeedback {
    return this.processRep(assessment, timestampMs);
  }

  getGoodStreak(): number {
    return this.goodStreak;
  }

  getTotalValidReps(): number {
    return this.totalValidReps;
  }
}
