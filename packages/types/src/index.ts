/**
 * packages/types — shared contracts.
 *
 * Every module in the app depends on these. They mirror the Python side
 * (ml/src/) exactly; see docs/FEATURE_SCHEMA.md and docs/POSE_SCHEMA.md.
 */

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

export interface Landmark {
  /** Normalized [0,1], origin top-left. */
  x: number;
  /** Normalized [0,1], origin top-left, increases downward. */
  y: number;
  /** Depth relative to hips. */
  z: number;
  /** Model confidence for this landmark, [0,1]. */
  visibility: number;
}

/**
 * One pose frame. `valid` is false when the active side's mean visibility
 * fell below MIN_VISIBILITY — downstream code must not use the geometry
 * fields in that case, they will be NaN.
 */
export interface PoseCapability {
  canCountRep: boolean;
  canGradeDepth: boolean;
  canGradeAlignment: boolean;
  canGradeSymmetry: boolean;
  canGradeTempo: boolean;
  canFullyAssessForm: boolean;
}

export interface PoseFrame {
  timestamp: number;
  landmarks: Landmark[];
  /** MediaPipe world landmarks in meters, hip-origin. Never persist as video. */
  worldLandmarks?: Landmark[];
  /** Which body side the geometry was derived from. */
  side: 'left' | 'right';
  valid: boolean;
  /** Mean visibility of the active side. */
  sideVisibility: number;
  capability?: PoseCapability;
}

export type CameraView = 'side' | 'diagonal' | 'front';

export type V2CameraView =
  | 'VIEW_UNKNOWN'
  | 'VIEW_FRONT'
  | 'VIEW_SIDE_LEFT'
  | 'VIEW_SIDE_RIGHT'
  | 'VIEW_DIAGONAL_LEFT'
  | 'VIEW_DIAGONAL_RIGHT';

export type UserViewMode = 'AUTO' | 'FRONT' | 'SIDE' | 'DIAGONAL';

export interface ViewEvidence {
  shoulderWidthRel: number;
  hipWidthRel: number;
  shoulderDepthDiff: number;
  hipDepthDiff: number;
  visibilitySymmetry: number;
  torsoYawDeg: number;
}

export interface ViewEstimate {
  view: V2CameraView;
  confidence: number;
  evidence: ViewEvidence;
  isLocked: boolean;
}

export interface RepMotionSignal {
  timestamp: number;
  phaseEvidence: number;
  elbowLeft: number;
  elbowRight: number;
  elbowCombined: number;
  shoulderMotion: number;
  hipMotion: number;
  worldDepthMotion: number;
  poseConfidence: number;
  view: V2CameraView;
  /** V3 extras — optional so V2 extractors remain valid. */
  elbowLeft2D?: number;
  elbowRight2D?: number;
  elbowLeft3D?: number;
  elbowRight3D?: number;
  shoulderCenterX?: number;
  shoulderCenterY?: number;
  shoulderCenterZ?: number;
  hipCenterX?: number;
  hipCenterY?: number;
  hipCenterZ?: number;
  shoulderWorldZ?: number;
  torsoWorldZ?: number;
  shoulderWristDist?: number;
  centroidY?: number;
  leftVisibility?: number;
  rightVisibility?: number;
  elbowVelocity?: number;
}

// ---------------------------------------------------------------------------
// Per-frame biomechanics (mirrors ml/src/features.py FrameFeatures)
// ---------------------------------------------------------------------------

export interface FrameFeatures {
  valid: boolean;
  side: 'left' | 'right';
  elbowAngle: number;
  elbowAngleOpposite: number;
  shoulderAngle: number;
  hipAngle: number;
  kneeAngle: number;
  ankleAngle: number;
  bodyLineDeviation: number;
  shoulderHipAnkleAngle: number;
  torsoSlope: number;
  hipHeightRel: number;
  shoulderHeightRel: number;
  shoulderElbowHeightDelta: number;
  shoulderAnkleHeightDelta: number;
  meanVisibility: number;
  minVisibility: number;
  jitter: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Rep counting
// ---------------------------------------------------------------------------

export type RepState =
  | 'READY'
  | 'UP'
  | 'DESCENDING'
  | 'DOWN'
  | 'ASCENDING';

/** V3 coherent-cycle detector. Independent of the V2 elbow-threshold FSM. */
export type V3RepState =
  | 'WAITING'
  | 'TOP_CONFIRMED'
  | 'DESCENDING'
  | 'BOTTOM_CONFIRMED'
  | 'ASCENDING'
  | 'TOP_RETURNED'
  | 'COMPLETE'
  | 'REARMING';

export interface MotionEvidence {
  elbowEvidence: number;
  depthEvidence: number;
  centroidEvidence: number;
  distanceEvidence: number;
  bilateralAgreement: number;
  motionDirection: number;
  movementMagnitude: number;
  phaseConfidence: number;
  overallConfidence: number;
}

export interface PhaseEstimate {
  phase: number;
  confidence: number;
  elbowPhase: number;
  depthPhase: number;
  centroidPhase: number;
  distancePhase: number;
}

export interface PersonalRom {
  elbowTop: number;
  elbowBottom: number;
  shoulderYTop: number;
  shoulderYBottom: number;
  depthTop: number;
  depthBottom: number;
  distTop: number;
  distBottom: number;
  depthPolarity: number;
  shoulderYPolarity: number;
  distPolarity: number;
  samples: number;
}

export interface RepCycleEvent {
  index: number;
  startTime: number;
  bottomTime: number;
  endTime: number;
  durationS: number;
  phaseExcursion: number;
  angularExcursion: number;
  depthExcursion: number;
  elbowMin: number;
  elbowMax: number;
  shoulderYTop: number;
  shoulderYBottom: number;
  depthTop: number;
  depthBottom: number;
  distTop: number;
  distBottom: number;
  bilateralAgreement: number;
  directionConsistency: number;
  overallConfidence: number;
  counted: boolean;
  rejectionReason: string | null;
  frames: FrameFeatures[];
}

export interface GroundTruthRep {
  start: number;
  bottom: number;
  end: number;
}

export interface DetectedRepInterval {
  start: number;
  bottom: number;
  end: number;
}

export interface EventMatchReport {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  mae: number;
  medianAbsError: number;
  exactCountRate: number;
  within1Rate: number;
}

export interface LiveTraceFrame {
  timestamp: number;
  view: V2CameraView;
  viewConfidence: number;
  leftShoulder: { x: number; y: number; z: number; visibility: number };
  leftElbow: { x: number; y: number; z: number; visibility: number };
  leftWrist: { x: number; y: number; z: number; visibility: number };
  rightShoulder: { x: number; y: number; z: number; visibility: number };
  rightElbow: { x: number; y: number; z: number; visibility: number };
  rightWrist: { x: number; y: number; z: number; visibility: number };
  hipCenter: { x: number; y: number; z: number };
  shoulderCenter: { x: number; y: number; z: number };
  leftElbow2D: number;
  rightElbow2D: number;
  leftElbow3D: number;
  rightElbow3D: number;
  bilateralFusedAngle: number;
  shoulderImageMovement: number;
  shoulderWorldZ: number;
  torsoWorldZ: number;
  poseConfidence: number;
  rawRepSignal: number;
  filteredRepSignal: number;
  normalizedMovementPhase: number;
  fsmState: V3RepState;
  counterConfidence: number;
  candidateCycleId: number | null;
  repEventEmitted: boolean;
  rejectionReason: string | null;
  calibration: PersonalRom;
  adaptiveRom: PersonalRom;
}

export type WorkoutMode = 'free' | 'target' | 'form-practice' | 'challenge-30' | 'challenge-60';

export interface RepThresholds {
  upEnter: number;
  upExit: number;
  downEnter: number;
  downExit: number;
  calibrated: boolean;
  observedMin: number;
  observedMax: number;
}

export interface RepEvent {
  index: number;
  startTime: number;
  endTime: number;
  durationS: number;
  minElbowAngle: number;
  maxElbowAngle: number;
  /** Frames belonging to this rep, for form aggregation. */
  frames: FrameFeatures[];
}

// ---------------------------------------------------------------------------
// Form assessment
// ---------------------------------------------------------------------------

export type FormLabel = 'good' | 'bad' | 'unknown';
export type FormStatus = 'GOOD' | 'BAD' | 'UNCERTAIN';

export interface GeometryIssue {
  issueCode: IssueCode;
  severity: number;
  confidence: number;
  measurements: Record<string, number>;
  evidence: string;
}

export type CalibrationPhase =
  | 'CAMERA_CHECK'
  | 'HOLD_TOP'
  | 'MOVEMENT_CALIBRATION'
  | 'COUNTDOWN'
  | 'READY';

export interface TwoStageCalibrationState {
  phase: CalibrationPhase;
  cameraChecksPassed: boolean;
  calibrationRepsCompleted: number;
  calibrationRepsRequired: number;
  observedTop: number;
  observedBottom: number;
  effectiveRom: number;
  feedbackPrompt: string;
  ready: boolean;
}

export interface CorrectionStatus {
  targetIssue: IssueCode;
  baselineMetric: number;
  currentMetric: number;
  improved: boolean;
  message: string;
}

export type IssueCode =
  | 'INCOMPLETE_DEPTH'
  | 'SHALLOW_DEPTH'
  | 'HIPS_TOO_HIGH'
  | 'HIP_PIKE'
  | 'HIPS_DROPPING'
  | 'HIP_SAG'
  | 'BODY_NOT_STRAIGHT'
  | 'BODY_ALIGNMENT'
  | 'ELBOW_FLARE'
  | 'ARM_ASYMMETRY'
  | 'TOO_FAST'
  | 'TEMPO_TOO_FAST'
  | 'TEMPO_TOO_SLOW'
  | 'INCOMPLETE_LOCKOUT'
  | 'KNEES_BENT'
  | 'PARTIAL_RANGE'
  | 'UNSTABLE'
  | 'LOW_CONFIDENCE';

export interface ScoreComponents {
  depth: number;
  alignment: number;
  tempo: number;
  consistency: number;
  rom: number;
}

export interface RepAssessment {
  repIndex: number;
  label: FormLabel;
  formStatus?: FormStatus;
  uncertain?: boolean;
  /** Model probability of the `label` class. */
  confidence: number;
  /** Raw P(good) from the model, regardless of label. */
  goodProbability: number;
  valid: boolean;
  /** 0-100 blended score. */
  repScore: number;
  geometryScore: number;
  modelScore: number | null;
  components: ScoreComponents;
  primaryIssue: IssueCode | null;
  secondaryIssues: IssueCode[];
  /** Whether the score came from a real model or geometry rules only. */
  scoreSource: 'model+geometry' | 'geometry-only';
  /** True when confidence was too close to the threshold to call. */
  borderline: boolean;
  missingFeatureCount: number;
}

// ---------------------------------------------------------------------------
// Workout session
// ---------------------------------------------------------------------------

export type SessionMode = 'workout' | 'challenge';

export interface WorkoutMetrics {
  totalReps: number;
  validReps: number;
  invalidReps: number;
  uncertainReps?: number;
  formScore: number | null;
  bestStreak: number;
  meanRepSeconds: number | null;
  mostCommonIssue: IssueCode | null;
  /** 'provisional' when fewer than 3 reps — score is not yet reliable. */
  scoreStatus: 'ok' | 'provisional' | 'insufficient-data';
}

export interface WorkoutSessionRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  totalReps: number;
  validReps: number;
  invalidReps: number;
  uncertainReps?: number;
  formScore: number | null;
  viewType: CameraView;
  mode: SessionMode;
  bestStreak: number;
  meanRepSeconds: number | null;
  mostCommonIssue: IssueCode | null;
  createdAt: string;
}

export interface WorkoutRepRecord {
  repNumber: number;
  valid: boolean;
  formProbability: number;
  formLabel: FormLabel;
  formStatus?: FormStatus;
  uncertain?: boolean;
  depthScore: number;
  alignmentScore: number;
  tempoScore: number;
  consistencyScore: number;
  consistency_score?: number;
  repScore: number;
  detectedIssue: IssueCode | null;
  repDurationSeconds: number;
  minElbowAngleDeg: number;
  bodyLineDeviationMax: number;
  coachMessage?: string;
  isCorrection?: boolean;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationCheck {
  id: string;
  label: string;
  passed: boolean;
  /** Actionable guidance when the check fails. */
  hint: string;
}

export interface CalibrationState {
  fullBodyVisible: boolean;
  poseDetected: boolean;
  view: CameraView | null;
  viewAcceptable: boolean;
  lightingOk: boolean;
  distanceOk: boolean;
  stable: boolean;
  poseConfidence: number;
  checks: CalibrationCheck[];
  ready: boolean;
  /** Population count, for the multiple-people error state. */
  peopleCount: number;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export interface FeedbackMessage {
  headline: string;
  detail: string;
  tone: 'positive' | 'corrective' | 'neutral' | 'warning';
  issueCode: IssueCode | null;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  validReps: number;
  invalidReps: number;
  formScore: number;
  durationSeconds: number;
  bestStreak: number;
  mode: string;
  createdAt: string;
  /** Present only for locally-created entries not yet synced. */
  local?: boolean;
}

// ---------------------------------------------------------------------------
// Capture error states
// ---------------------------------------------------------------------------

export type CaptureErrorCode =
  | 'PERMISSION_DENIED'
  | 'NO_CAMERA'
  | 'CAMERA_IN_USE'
  | 'INSECURE_CONTEXT'
  | 'INIT_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'NO_PERSON'
  | 'MULTIPLE_PEOPLE'
  | 'FEET_OUT_OF_FRAME'
  | 'MOVE_FARTHER'
  | 'LOW_CONFIDENCE'
  | 'TURN_SIDEWAYS'
  | 'BACKEND_UNAVAILABLE'
  | 'PAUSED'
  | 'UNKNOWN';

export interface CaptureError {
  code: CaptureErrorCode;
  title: string;
  detail: string;
  /** Whether the user can recover by adjusting something. */
  recoverable: boolean;
}
