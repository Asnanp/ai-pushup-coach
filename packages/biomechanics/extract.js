/**
 * packages/biomechanics/extract.ts
 *
 * Runtime frame-feature extraction. TypeScript mirror of the
 * `extract_frame_features` / `aggregate_rep_window` pair in
 * ml/src/features.py.
 *
 * See docs/FEATURE_SCHEMA.md for the authoritative specification.
 */
import { L_ANKLE, L_ELBOW, L_FOOT, L_HIP, L_KNEE, L_SHOULDER, L_WRIST, R_ANKLE, R_ELBOW, R_FOOT, R_HIP, R_KNEE, R_SHOULDER, R_WRIST, angleDeg, signedBodyLineDeviation, toVec, vlen, vmid, vsub, } from './geometry';
export const MIN_VISIBILITY = 0.5;
/** Must match ml/src/features.py FEATURE_NAMES exactly, same order. */
export const FEATURE_NAMES = [
    // A — angles
    'elbow_angle_deg_mean',
    'elbow_angle_deg_min',
    'elbow_angle_deg_max',
    'shoulder_angle_deg_mean',
    'hip_angle_deg_mean',
    'hip_angle_deg_min',
    'knee_angle_deg_mean',
    // B — alignment
    'body_line_deviation_mean',
    'body_line_deviation_max_abs',
    'body_line_deviation_std',
    'shoulder_hip_ankle_angle_deg_mean',
    'torso_slope_deg_mean',
    'shoulder_ankle_height_delta_mean',
    // C — depth / rom
    'shoulder_elbow_height_delta_min',
    'shoulder_elbow_height_delta_mean',
    'rom_elbow_deg',
    'min_elbow_angle_deg',
    'depth_ratio',
    // D — tempo
    'elbow_angular_velocity_max',
    'elbow_angular_velocity_mean',
    'elbow_velocity_down_mean',
    'elbow_velocity_up_mean',
    'rep_duration_s',
    'descent_duration_s',
    'ascent_duration_s',
    'descent_ascent_ratio',
    // E — stability
    'elbow_angle_std',
    'hip_height_std',
    'hip_vertical_velocity_max',
    'shoulder_vertical_velocity_max',
    'pause_at_bottom_s',
    'jitter_score',
    'body_line_deviation_range',
    // F — quality
    'mean_visibility',
    'min_visibility',
    'tracking_gap_ratio',
    'elbow_angle_opposite_deg_mean',
];
export const N_FEATURES = FEATURE_NAMES.length; // 37
export const FEATURE_SPEC_VERSION = 1;
export const DEPTH_TARGET_DEG = 90;
export const DEPTH_TOP_DEG = 160;
/** Reusable NaN frame so callers can branch on `.valid` cheaply. */
function invalidFrame(side, timestamp) {
    return {
        valid: false,
        side,
        elbowAngle: NaN,
        elbowAngleOpposite: NaN,
        shoulderAngle: NaN,
        hipAngle: NaN,
        kneeAngle: NaN,
        ankleAngle: NaN,
        bodyLineDeviation: NaN,
        shoulderHipAnkleAngle: NaN,
        torsoSlope: NaN,
        hipHeightRel: NaN,
        shoulderHeightRel: NaN,
        shoulderElbowHeightDelta: NaN,
        shoulderAnkleHeightDelta: NaN,
        meanVisibility: 0,
        minVisibility: 0,
        jitter: 0,
        timestamp,
    };
}
/**
 * Derive all per-frame geometry from one pose frame.
 *
 * Mirrors Python `extract_frame_features`. The torso-normalization step is the
 * important part: after translating to the hip, rotating to align the torso,
 * and dividing by torso length, camera distance and subject size cancel out.
 * That is why the model cannot learn "who" the person is.
 */
export function extractFrameFeatures(pose, ctx) {
    const lms = pose.landmarks;
    const side = pose.side;
    if (!pose.valid || lms.length < 33) {
        return invalidFrame(side, pose.timestamp);
    }
    const idx = side === 'left'
        ? { sh: L_SHOULDER, el: L_ELBOW, wr: L_WRIST, hp: L_HIP, kn: L_KNEE, an: L_ANKLE, ft: L_FOOT }
        : { sh: R_SHOULDER, el: R_ELBOW, wr: R_WRIST, hp: R_HIP, kn: R_KNEE, an: R_ANKLE, ft: R_FOOT };
    const oIdx = side === 'left'
        ? { sh: R_SHOULDER, el: R_ELBOW, wr: R_WRIST }
        : { sh: L_SHOULDER, el: L_ELBOW, wr: L_WRIST };
    const meanVisibility = meanOf(lms, [L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_HIP, R_HIP]);
    const minVisibility = minOf(lms, [
        L_SHOULDER, R_SHOULDER, L_HIP, R_HIP, L_ANKLE, R_ANKLE,
    ]);
    // --- torso frame ---
    const shoulderMidRaw = vmid(toVec(lms[L_SHOULDER]), toVec(lms[R_SHOULDER]));
    const hipMidRaw = vmid(toVec(lms[L_HIP]), toVec(lms[R_HIP]));
    const torsoVec = vsub(shoulderMidRaw, hipMidRaw);
    let torsoHeight = vlen(torsoVec);
    if (torsoHeight < 1e-6)
        torsoHeight = 1e-6;
    const torsoAngle = Math.atan2(torsoVec.y, torsoVec.x);
    // --- normalize every landmark into torso space ---
    const cosA = Math.cos(-torsoAngle);
    const sinA = Math.sin(-torsoAngle);
    const norm = lms.map((lm) => {
        const rx = lm.x - hipMidRaw.x;
        const ry = lm.y - hipMidRaw.y;
        return {
            x: (cosA * rx - sinA * ry) / torsoHeight,
            y: (sinA * rx + cosA * ry) / torsoHeight,
        };
    });
    // --- angles ---
    const elbowAngle = angleDeg(norm[idx.sh], norm[idx.el], norm[idx.wr]);
    const elbowAngleOpp = angleDeg(norm[oIdx.sh], norm[oIdx.el], norm[oIdx.wr]);
    const shoulderAngle = angleDeg(norm[idx.el], norm[idx.sh], norm[idx.hp]);
    const hipAngle = angleDeg(norm[idx.sh], norm[idx.hp], norm[idx.kn]);
    const kneeAngle = angleDeg(norm[idx.hp], norm[idx.kn], norm[idx.an]);
    const ankleAngle = angleDeg(norm[idx.kn], norm[idx.an], norm[idx.ft]);
    // --- midline ---
    const shMid = vmid(norm[L_SHOULDER], norm[R_SHOULDER]);
    const hpMid = vmid(norm[L_HIP], norm[R_HIP]);
    const anMid = vmid(norm[L_ANKLE], norm[R_ANKLE]);
    const bodyLineDev = signedBodyLineDeviation(shMid, hpMid, anMid);
    const shaAngle = angleDeg(shMid, hpMid, anMid);
    const shToHip = vsub(shMid, hpMid);
    const torsoSlope = (Math.atan2(shToHip.y, shToHip.x) * 180) / Math.PI;
    // --- jitter ---
    let jitter = 0;
    if (ctx.prevNormalized) {
        const key = [
            L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_HIP, R_HIP, L_KNEE, R_KNEE, L_ANKLE, R_ANKLE,
        ];
        const d = [];
        for (const i of key) {
            const prev = ctx.prevNormalized[i];
            if (prev && norm[i])
                d.push(vlen(vsub(norm[i], prev)));
        }
        jitter = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
    }
    return {
        valid: true,
        side,
        elbowAngle,
        elbowAngleOpposite: elbowAngleOpp,
        shoulderAngle,
        hipAngle,
        kneeAngle,
        ankleAngle,
        bodyLineDeviation: bodyLineDev,
        shoulderHipAnkleAngle: shaAngle,
        torsoSlope,
        hipHeightRel: hpMid.y,
        shoulderHeightRel: shMid.y,
        shoulderElbowHeightDelta: norm[idx.el].y - norm[idx.sh].y,
        shoulderAnkleHeightDelta: shMid.y - anMid.y,
        meanVisibility,
        minVisibility,
        jitter,
        timestamp: pose.timestamp,
    };
}
// ---------------------------------------------------------------------------
// Window aggregation -> 37-vector
// ---------------------------------------------------------------------------
function finite(values) {
    return values.filter((v) => Number.isFinite(v));
}
function mean(values) {
    const f = finite(values);
    return f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
}
function min(values) {
    const f = finite(values);
    return f.length ? Math.min(...f) : 0;
}
function max(values) {
    const f = finite(values);
    return f.length ? Math.max(...f) : 0;
}
function std(values) {
    const f = finite(values);
    if (f.length < 2)
        return 0;
    const m = f.reduce((a, b) => a + b, 0) / f.length;
    return Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / f.length);
}
function percentile(values, p) {
    const f = finite(values).sort((a, b) => a - b);
    if (!f.length)
        return 0;
    const i = (f.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? f[lo] : f[lo] + (f[hi] - f[lo]) * (i - lo);
}
function longestRun(ts, mask) {
    let best = 0;
    let start = -1;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] && start < 0)
            start = i;
        else if (!mask[i] && start >= 0) {
            best = Math.max(best, ts[i - 1] - ts[start]);
            start = -1;
        }
    }
    if (start >= 0)
        best = Math.max(best, ts[ts.length - 1] - ts[start]);
    return best;
}
/**
 * Aggregate one rep's frames into the 37-dim model vector.
 *
 * Mirrors Python `aggregate_rep_window`.
 */
export function aggregateRepWindow(frames, totalFramesInWindow) {
    const valid = frames.filter((f) => f.valid && Number.isFinite(f.elbowAngle));
    const nWindow = totalFramesInWindow ?? frames.length;
    if (valid.length === 0)
        return null;
    const t = valid.map((f) => f.timestamp);
    const elbow = valid.map((f) => f.elbowAngle);
    const hipH = valid.map((f) => f.hipHeightRel);
    const shH = valid.map((f) => f.shoulderHeightRel);
    const bline = valid.map((f) => f.bodyLineDeviation);
    const deriv = (s) => {
        const out = [];
        for (let i = 1; i < s.length; i++) {
            let dt = t[i] - t[i - 1];
            if (dt <= 1e-6)
                dt = 1e-6;
            out.push((s[i] - s[i - 1]) / dt);
        }
        return out;
    };
    const dElbow = deriv(elbow);
    const dHip = deriv(hipH);
    const dSh = deriv(shH);
    const elbowMin = min(elbow);
    const elbowMax = max(elbow);
    // Locate top (max extension) then bottom (max flexion) after it.
    let peakIdx = 0;
    let troughIdx = 0;
    for (let i = 0; i < elbow.length; i++) {
        if (elbow[i] > elbow[peakIdx])
            peakIdx = i;
        if (elbow[i] < elbow[troughIdx])
            troughIdx = i;
    }
    if (troughIdx < peakIdx) {
        const tmp = peakIdx;
        peakIdx = troughIdx;
        troughIdx = tmp;
    }
    const repDuration = t.length >= 2 ? t[t.length - 1] - t[0] : 0;
    const descentDuration = Math.max(0, t[troughIdx] - t[peakIdx]);
    const ascentDuration = Math.max(0, t[t.length - 1] - t[troughIdx]);
    const descAscRatio = ascentDuration > 1e-6 ? descentDuration / ascentDuration : 0;
    const downVel = dElbow.filter((v) => v < 0);
    const upVel = dElbow.filter((v) => v > 0);
    const rom = elbowMax - elbowMin;
    const depthRatio = clamp((DEPTH_TOP_DEG - elbowMin) / (DEPTH_TOP_DEG - DEPTH_TARGET_DEG), 0, 1);
    const bottomMask = elbow.map((v) => v <= elbowMin + 10);
    const topMask = elbow.map((v) => v >= elbowMax - 10);
    const raw = {
        elbow_angle_deg_mean: mean(elbow),
        elbow_angle_deg_min: elbowMin,
        elbow_angle_deg_max: elbowMax,
        shoulder_angle_deg_mean: mean(valid.map((f) => f.shoulderAngle)),
        hip_angle_deg_mean: mean(valid.map((f) => f.hipAngle)),
        hip_angle_deg_min: min(valid.map((f) => f.hipAngle)),
        knee_angle_deg_mean: mean(valid.map((f) => f.kneeAngle)),
        body_line_deviation_mean: mean(bline),
        body_line_deviation_max_abs: finite(bline).length ? Math.max(...bline.map(Math.abs)) : 0,
        body_line_deviation_std: std(bline),
        body_line_deviation_range: finite(bline).length ? max(bline) - min(bline) : 0,
        shoulder_hip_ankle_angle_deg_mean: mean(valid.map((f) => f.shoulderHipAnkleAngle)),
        torso_slope_deg_mean: mean(valid.map((f) => f.torsoSlope)),
        shoulder_ankle_height_delta_mean: mean(valid.map((f) => f.shoulderAnkleHeightDelta)),
        shoulder_elbow_height_delta_min: min(valid.map((f) => f.shoulderElbowHeightDelta)),
        shoulder_elbow_height_delta_mean: mean(valid.map((f) => f.shoulderElbowHeightDelta)),
        rom_elbow_deg: rom,
        min_elbow_angle_deg: elbowMin,
        depth_ratio: depthRatio,
        elbow_angular_velocity_max: dElbow.length ? Math.max(...dElbow.map(Math.abs)) : 0,
        elbow_angular_velocity_mean: mean(dElbow),
        elbow_velocity_down_mean: mean(downVel),
        elbow_velocity_up_mean: mean(upVel),
        rep_duration_s: repDuration,
        descent_duration_s: descentDuration,
        ascent_duration_s: ascentDuration,
        descent_ascent_ratio: descAscRatio,
        elbow_angle_std: std(elbow),
        hip_height_std: std(hipH),
        hip_vertical_velocity_max: dHip.length ? Math.max(...dHip.map(Math.abs)) : 0,
        shoulder_vertical_velocity_max: dSh.length ? Math.max(...dSh.map(Math.abs)) : 0,
        pause_at_bottom_s: longestRun(t, bottomMask),
        pause_at_top_s: longestRun(t, topMask),
        jitter_score: mean(valid.map((f) => f.jitter)),
        mean_visibility: mean(valid.map((f) => f.meanVisibility)),
        min_visibility: min(valid.map((f) => f.minVisibility)),
        tracking_gap_ratio: 1 - valid.length / Math.max(nWindow, 1),
        elbow_angle_opposite_deg_mean: mean(valid.map((f) => f.elbowAngleOpposite)),
    };
    const vector = new Float64Array(N_FEATURES);
    FEATURE_NAMES.forEach((name, i) => {
        vector[i] = raw[name] ?? NaN;
    });
    return { vector, raw };
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function meanOf(lms, idx) {
    let s = 0;
    let n = 0;
    for (const i of idx) {
        if (lms[i]) {
            s += lms[i].visibility;
            n++;
        }
    }
    return n ? s / n : 0;
}
function minOf(lms, idx) {
    let m = Infinity;
    for (const i of idx)
        if (lms[i])
            m = Math.min(m, lms[i].visibility);
    return Number.isFinite(m) ? m : 0;
}
/** Percentiles, exported for the diagnostics panel. */
export const stats = { mean, min, max, std, percentile };
//# sourceMappingURL=extract.js.map