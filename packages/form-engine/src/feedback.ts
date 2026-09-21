/**
 * packages/form-engine/feedback.ts
 *
 * Agent 14 — FORM FEEDBACK ENGINE (copy layer)
 *
 * Turns a numeric assessment into human-readable feedback.
 *
 * The rule from spec §8: do NOT pretend the model identified a specific
 * mistake unless the features actually support that conclusion. So this file
 * has two distinct registers:
 *
 *   1. When a geometric issue was detected -> name it specifically and say
 *      what to change. We have the measurement, so we can be concrete.
 *   2. When the model says "bad" but no geometric rule fired -> say the form
 *      needs attention *without* inventing a cause. Show uncertainty.
 *
 * Inventing a diagnosis is the fastest way to make a CV project dishonest and
 * the fastest way to give a user advice that does not apply to them.
 */

import type { FeedbackMessage, IssueCode, RepAssessment } from '@ai-pushup-coach/types';

interface IssueCopy {
  headline: string;
  detail: string;
  tip: string;
}

/** Guidance per issue. Deliberately specific and actionable. */
export const ISSUE_COPY: Record<IssueCode, IssueCopy> = {
  INCOMPLETE_DEPTH: {
    headline: 'Go deeper',
    detail: 'Your chest is not getting close enough to the floor at the bottom of the rep.',
    tip: 'Lower until your elbows reach about 90 degrees. Your chest should come within a fist of the floor.',
  },
  SHALLOW_DEPTH: {
    headline: 'Go a little lower',
    detail: 'That attempt counted, but the bottom of the push-up was shallow.',
    tip: 'Lower until your elbows are near 90 degrees.',
  },
  HIPS_TOO_HIGH: {
    headline: 'Hips too high',
    detail: 'Your hips are piked up, so your body is not forming a straight line.',
    tip: 'Lower your hips until your shoulders, hips and ankles line up. Squeeze your glutes to hold it.',
  },
  HIP_PIKE: {
    headline: 'Hips too high',
    detail: 'Your hips are piked up, so your body is not forming a straight line.',
    tip: 'Lower your hips until your shoulders, hips and ankles line up.',
  },
  HIPS_DROPPING: {
    headline: 'Hips are sagging',
    detail: 'Your hips are dropping toward the floor instead of staying in line with your body.',
    tip: 'Brace your core as if bracing for a punch, and keep your body in one straight line from head to heels.',
  },
  HIP_SAG: {
    headline: 'Hips are sagging',
    detail: 'Your hips are dropping toward the floor instead of staying in line with your body.',
    tip: 'Brace your core and keep a straight line from head to heels.',
  },
  BODY_NOT_STRAIGHT: {
    headline: 'Keep your body in one line',
    detail: 'Your body line changed noticeably during the rep.',
    tip: 'Lock your core and glutes before you start, and keep that tension through the whole movement.',
  },
  BODY_ALIGNMENT: {
    headline: 'Keep your body in one line',
    detail: 'Alignment drifted during the rep.',
    tip: 'Lock your core and glutes and keep that tension through the whole movement.',
  },
  ELBOW_FLARE: {
    headline: 'Elbows flaring out',
    detail: 'Your elbows are angled away from your body rather than tucked back.',
    tip: 'Tuck your elbows to roughly 45 degrees from your torso rather than straight out to the sides.',
  },
  ARM_ASYMMETRY: {
    headline: 'Even out your arms',
    detail: 'One arm is working through a different range than the other.',
    tip: 'Press evenly through both hands.',
  },
  TOO_FAST: {
    headline: 'Slow down',
    detail: 'You are moving through the rep faster than you can control.',
    tip: 'Aim for about two seconds down and two seconds up. Control beats speed for building strength.',
  },
  TEMPO_TOO_FAST: {
    headline: 'Slow down',
    detail: 'That rep was faster than you can control.',
    tip: 'Take about two seconds down and two seconds up.',
  },
  TEMPO_TOO_SLOW: {
    headline: 'Keep a steady tempo',
    detail: 'The rep stalled long enough to lose the movement pattern.',
    tip: 'Move continuously, pausing only briefly at the top or bottom.',
  },
  INCOMPLETE_LOCKOUT: {
    headline: 'Finish at the top',
    detail: 'Your arms did not fully straighten at the top of the rep.',
    tip: 'Press all the way up until your elbows lock out.',
  },
  KNEES_BENT: {
    headline: 'Legs are bending',
    detail: 'Your knees are bent, which takes the work away from your chest and arms.',
    tip: 'Keep your legs straight and your feet together, resting on your toes.',
  },
  PARTIAL_RANGE: {
    headline: 'Use your full range',
    detail: 'Your elbows are barely moving through the rep.',
    tip: 'Go all the way down and all the way back up to full lockout each time.',
  },
  UNSTABLE: {
    headline: 'Keep the movement smooth',
    detail: 'Your joints are moving unevenly through the rep.',
    tip: 'Reduce your speed slightly and focus on a smooth, steady path.',
  },
  LOW_CONFIDENCE: {
    headline: 'Form could not be scored',
    detail: 'We could not track your body reliably enough to judge this rep.',
    tip: 'Improve the lighting and make sure your whole body stays in frame.',
  },
};

export const NEUTRAL_GOOD: FeedbackMessage = {
  headline: 'Good form!',
  detail: 'Keep your body straight and maintain a steady tempo.',
  tone: 'positive',
  issueCode: null,
};

/**
 * Build the feedback message for a completed rep.
 */
export function buildFeedback(assessment: RepAssessment): FeedbackMessage {
  const { label, primaryIssue, borderline, confidence } = assessment;

  // Unknown: be honest that we could not score it.
  if (label === 'unknown') {
    const copy = ISSUE_COPY.LOW_CONFIDENCE;
    return {
      headline: copy.headline,
      detail: copy.detail,
      tone: 'warning',
      issueCode: 'LOW_CONFIDENCE',
    };
  }

  if (label === 'good') {
    if (borderline) {
      return {
        headline: 'Good rep — just',
        detail: 'This rep was close to our quality threshold. Keep your depth and alignment consistent.',
        tone: 'neutral',
        issueCode: null,
      };
    }
    return { ...NEUTRAL_GOOD };
  }

  // Bad rep WITH a detected geometric cause — name it.
  if (primaryIssue && ISSUE_COPY[primaryIssue]) {
    const copy = ISSUE_COPY[primaryIssue];
    return {
      headline: copy.headline,
      detail: copy.detail,
      tone: 'corrective',
      issueCode: primaryIssue,
    };
  }

  // Bad rep WITHOUT a specific geometric cause. Say so honestly.
  return {
    headline: 'Form needs attention',
    detail:
      confidence > 0
        ? 'The movement pattern in this rep differed from a clean push-up, but no single fault stood out strongly.'
        : 'This rep did not match a clean push-up pattern.',
    tone: 'corrective',
    issueCode: null,
  };
}

/** Short tip shown in the bottom bar. */
export function tipForIssue(issue: IssueCode | null): string {
  if (!issue) return 'Engage your core to keep your body stable throughout the movement.';
  return ISSUE_COPY[issue]?.tip ?? 'Keep your body straight and move in a controlled way.';
}

/** Human label for an issue code, for tables and summaries. */
export function issueLabel(code: IssueCode | null): string {
  if (!code) return 'None';
  return ISSUE_COPY[code]?.headline ?? String(code);
}

/**
 * Aggregate response when the whole session is done.
 */
export function buildSessionSummary(m: {
  validReps: number;
  totalReps: number;
  bestStreak: number;
  formScore: number | null;
}): string {
  if (m.totalReps === 0) {
    return 'No reps were recorded. Make sure your full body is in frame and try again.';
  }
  const accuracy = m.totalReps > 0 ? (m.validReps / m.totalReps) * 100 : 0;
  if (accuracy >= 90) return 'Excellent consistency. Your form held up well across the set.';
  if (accuracy >= 70) return 'Solid set. A few reps drifted — review the breakdown below.';
  if (accuracy >= 50) return 'Good effort. Focus on the issue highlighted below on your next set.';
  return 'Keep practising. Slow down and prioritise clean reps over rep count.';
}
