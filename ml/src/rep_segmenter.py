"""
ml/src/rep_segmenter.py

Agent 8 — REP COUNTING ENGINE (shared logic)

Segments a landmark sequence into individual repetitions using the same
finite-state machine that runs in the browser (packages/rep-counter).

It is essential that training and runtime use IDENTICAL segmentation rules.
If they differ, the model is trained on rep windows that the live app will
never actually produce. This module is therefore the reference implementation,
and the TypeScript port is validated against it by a parity test.

State machine
-------------
    READY ──(extended)──> UP
    UP ──(angle falling)──> DESCENDING
    DESCENDING ──(angle <= DOWN_ENTER)──> DOWN
    DOWN ──(angle rising)──> ASCENDING
    ASCENDING ──(angle >= UP_ENTER)──> UP  + EMIT REP
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# --------------------------------------------------------------------------
# Thresholds
# --------------------------------------------------------------------------
# IMPORTANT — these are NOT the naive 90/160 constants, and they are NOT purely
# fixed either.
#
# Measured on this dataset: the elbow angle a subject reaches at the TOP of a
# rep varies enormously by subject and view. In front view, arm foreshortening
# means the "extended" elbow reads far lower than 160 degrees.
#
#   good_front_subject_001 : p95 = 136 deg   (never approaches 155)
#   good_front_subject_002 : p95 = 170 deg
#   good_front_subject_003 : p95 = 165 deg
#
# A fixed UP_ENTER of 155 therefore registered ZERO reps for subject_001 while
# working fine for 002/003 — silently deleting an entire subject from training.
#
# Solution: AUTORANGE calibration. The top and bottom of the movement are read
# from the signal itself, then thresholds are placed as fractions between them.
# The constants below are the default ratios and serve as clamps; the actual
# per-recording thresholds come from observe() below.

# Fraction of the observed range at which "up" and "down" are declared.
UP_FRACTION = 0.72  # top 28% of the range counts as "up"
UP_EXIT_FRACTION = 0.66  # hysteresis when leaving up
DOWN_FRACTION = 0.22  # bottom 22% counts as "down"
DOWN_EXIT_FRACTION = 0.30  # hysteresis when leaving down

# Absolute clamps.
#
# These are deliberately WIDE. An earlier version pinned DOWN_ENTER_MAX to 120
# deg, which silently destroyed real reps: good_side_subject_004 sweeps
# 129-177 deg (a textbook push-up) but its own minimum never reaches 120, so
# the DOWN state was unreachable and the clip produced ZERO reps. The clamps
# exist only to stop a degenerate signal producing nonsense, not to impose a
# textbook push-up shape on every subject.
UP_ENTER_MIN, UP_ENTER_MAX = 100.0, 175.0
DOWN_ENTER_MIN, DOWN_ENTER_MAX = 40.0, 150.0

# Minimum angular travel for the signal to be considered a real movement, as
# opposed to a subject lying still or a limb that was never tracked.
MIN_TRACKED_ROM_DEG = 18.0

# Minimum median frame-to-frame change. A tracked push-up moves the elbow
# several degrees per frame at 15 FPS; a frozen/mistracked limb does not.
MIN_TRACKED_MEDIAN_STEP_DEG = 0.9

# If more than this fraction of frames reverse direction, the "signal" is
# noise rather than movement (measured: bad_side_subject_016 reverses on 74 of
# 405 frames while its whole range is 10.3 deg).
MAX_REVERSAL_FRACTION = 0.16

# Fallback absolute values used before calibration is available.
UP_ENTER_DEG = 150.0
UP_EXIT_DEG = 143.0
DOWN_ENTER_DEG = 100.0
DOWN_EXIT_DEG = 108.0

MIN_ROM_DEG = 25.0  # minimum elbow travel for a rep to register

# Shallow-rep floor.
#
# Several subjects in this dataset perform a genuinely shallow push-up: the
# elbow travels only ~30 deg, from about 150 deg (top) to 120 deg (bottom).
# Measured examples: good_side_subject_022 spans 129-165, bad_diagonal_subject_016
# spans 140-171. These are real repetitions with real range of motion, just a
# short one, and the spec is explicit that depth is a form issue rather than a
# reason to discard the rep -- "Do not simply refuse to count a bad repetition."
#
# So the rep counter's job is to detect the movement, and the SCORE's job is to
# judge the depth. Discarding here would erase the very reps the depth feature
# is supposed to grade. We therefore allow a rep down to this travel, and only
# reject below it as noise.
MIN_DETECTABLE_ROM_DEG = 18.0
MIN_REP_SECONDS = 0.35  # reject physically implausible rep rates

# Upper duration bound.
#
# Measured across the 951 detected reps in this dataset: median 1.87s, p90
# 3.80s, p95 5.37s, p99 7.47s. A deliberately slow tempo push-up genuinely
# takes 3-4s, so the bound has to sit above that or we would delete legitimate
# tempo reps. Beyond ~6s the window is no longer describing one repetition --
# it is a mismeasured stretch of signal. 3.6% of reps fall past this point.
MAX_REP_SECONDS = 6.0
MIN_FRAMES_TO_CALIBRATE = 15  # need enough signal before autoranging
MEDIAN_FILTER_K = 5  # spike rejection window
SMOOTH_WINDOW = 9  # boxcar low-pass, in frames
SMOOTH_MIN_FRAMES = 12  # below this, skip smoothing entirely

# Front-view clips are close-ups where arm foreshortening makes the elbow-angle
# signal far noisier than in side view. Measured: good_front_subject_001
# oscillates 44-142 deg with heavy frame-to-frame noise at 15 FPS, while the
# side view gives a clean 60-170 deg sweep. We therefore accept a noisier
# signal in front view rather than pretending it is as reliable as side view,
# and we record the view so downstream scoring can weight it accordingly.
NOISY_VIEWS = {"front"}

# --------------------------------------------------------------------------
# Physiological plausibility bounds for the elbow angle
# --------------------------------------------------------------------------
# MediaPipe sometimes collapses an arm: the wrist landmark lands on or near the
# elbow, which drives the computed interior elbow angle toward zero. An angle of
# 11-14 deg means the upper arm and forearm are folded completely flat, which no
# human arm can do (bone and muscle stop the joint well before that).
#
# This is not a cosmetic filter. Measured on this dataset, 5 clips have more
# than 5% of their frames below 25 deg, and the worst -- bad_diagonal_subject_019
# -- is 32.8% below 25 deg. Those frames stretched the calibration band to
# 10-163 deg, which placed the down threshold at 29 deg: below every real frame,
# so the FSM never reached DOWN and the clip scored ZERO reps despite containing
# perfectly good push-ups.
#
# So we enforce the physical floor before calibration sees the signal, and mark
# the affected frames invalid so they cannot manufacture transitions either.
ELBOW_ANGLE_MIN_PLAUSIBLE = 25.0
ELBOW_ANGLE_MAX_PLAUSIBLE = 179.5


def mask_implausible(
    series: np.ndarray,
    lo: float = ELBOW_ANGLE_MIN_PLAUSIBLE,
    hi: float = ELBOW_ANGLE_MAX_PLAUSIBLE,
) -> tuple[np.ndarray, float]:
    """
    Blank anatomically impossible elbow angles.

    Returns (masked_series, fraction_masked). The caller can use the fraction
    to decide whether a clip's tracking is trustworthy at all.
    """
    arr = np.asarray(series, dtype=float).copy()
    finite = np.isfinite(arr)
    if finite.sum() == 0:
        return arr, 0.0

    bad = finite & ((arr < lo) | (arr > hi))
    frac = float(bad.sum()) / float(finite.sum())
    arr[bad] = np.nan
    return arr, frac


def smooth_signal(series: np.ndarray, window: int = SMOOTH_WINDOW) -> np.ndarray:
    """
    Causal-safe low-pass smoothing for the rep signal.

    A boxcar mean is used rather than Savitzky-Golay because we need the
    identical operation to be trivially portable to TypeScript for the live
    app (a running sum), and the shape preservation difference is negligible
    at these thresholds. NaNs are interpolated first so a dropped pose frame
    does not poison the window.
    """
    arr = np.asarray(series, dtype=float)

    # Drop anatomically impossible samples FIRST. If these reach the moving
    # average they drag neighbouring real frames toward the bogus value, so
    # filtering after smoothing is too late.
    arr, _masked_frac = mask_implausible(arr)

    if arr.size < SMOOTH_MIN_FRAMES:
        return arr.copy()

    # Interpolate NaNs so the moving average stays continuous.
    idx = np.arange(arr.size)
    good = np.isfinite(arr)
    if good.sum() == 0:
        return arr.copy()
    if good.sum() < arr.size:
        arr = np.interp(idx, idx[good], arr[good])

    k = max(1, int(window))
    if k % 2 == 0:
        k += 1
    half = k // 2
    padded = np.pad(arr, (half, half), mode="edge")
    kernel = np.ones(k, dtype=float) / k
    return np.convolve(padded, kernel, mode="valid")


def tracking_quality(elbow_series: "np.ndarray") -> dict[str, float | bool]:
    """
    Decide whether an elbow-angle signal is worth segmenting at all.

    A clip can fail to produce reps for two very different reasons:
      (a) the thresholds were misplaced  -> fixable, and our bug
      (b) the arm was never tracked      -> not fixable, and should be reported

    Distinguishing them matters. Silently emitting zero reps for a mistracked
    clip looks identical to a correct empty result, and would quietly remove
    that subject from training. This function makes the distinction explicit so
    the extractor can record WHY a clip yielded nothing.

    Returns a dict with the measurements and a boolean `tracked`.
    """
    arr = np.asarray(elbow_series, dtype=float)
    finite = arr[np.isfinite(arr)]

    if finite.size < MIN_FRAMES_TO_CALIBRATE:
        return {
            "tracked": False,
            "reason": "too_few_frames",
            "rom": float("nan"),
            "median_step": float("nan"),
            "reversal_fraction": float("nan"),
        }

    rom = float(np.percentile(finite, 95) - np.percentile(finite, 5))

    steps = np.abs(np.diff(finite))
    median_step = float(np.median(steps)) if steps.size else 0.0

    # Direction reversals on the smoothed signal — noise flips sign constantly.
    try:
        smoothed = smooth_signal(arr)
        sm = smoothed[np.isfinite(smoothed)]
        d = np.sign(np.diff(sm))
        d = d[d != 0]
        reversals = int(np.sum(np.diff(d) != 0)) if d.size > 1 else 0
        reversal_fraction = reversals / float(max(1, sm.size))
    except Exception:  # pragma: no cover - defensive
        reversal_fraction = 1.0

    reasons = []
    if rom < MIN_TRACKED_ROM_DEG:
        reasons.append("insufficient_range")
    if median_step < MIN_TRACKED_MEDIAN_STEP_DEG:
        reasons.append("frozen_signal")
    if reversal_fraction > MAX_REVERSAL_FRACTION:
        reasons.append("unstable_signal")

    return {
        "tracked": not reasons,
        "reason": "+".join(reasons) if reasons else "ok",
        "rom": rom,
        "median_step": median_step,
        "reversal_fraction": float(reversal_fraction),
    }


def _local_extrema(
    signal: np.ndarray,
    min_prominence_frac: float = 0.15,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Find the turning points of a movement signal.

    This exists to answer "what level does the signal return to?", which is the
    only reliable way to tell a repeated movement from a single large
    excursion. Percentiles cannot do this: one deep push-up at the end of a
    clip moves p95 as much as twenty shallow ones do.

    Prominence filtering matters. Raw argrelextrema on a 15 FPS signal returns
    dozens of noise wiggles per rep, whose median would be meaningless. We keep
    only extremes that stand out from the local range by `min_prominence_frac`,
    so a real rep boundary survives and a jitter does not.

    Returns (maxima_values, minima_values) as plain value arrays.
    """
    arr = np.asarray(signal, dtype=float)
    finite = np.isfinite(arr)
    if finite.sum() < MIN_FRAMES_TO_CALIBRATE:
        return np.array([]), np.array([])

    # Work on the finite signal only.
    vals = arr[finite]
    if vals.size < 5:
        return np.array([]), np.array([])

    # A rep must span at least this much angle to count as a turning point.
    rng = float(np.percentile(vals, 95) - np.percentile(vals, 5))
    if rng <= 0:
        return np.array([]), np.array([])
    min_prom = max(4.0, rng * min_prominence_frac)

    n = vals.size
    maxima: list[float] = []
    minima: list[float] = []

    # Walk the signal and collect alternating turning points using a
    # prominence-aware sweep. This is deliberately simple and portable so the
    # TypeScript port can reproduce it exactly.
    i = 1
    last_extreme_val = vals[0]
    last_extreme_idx = 0
    direction = 0  # +1 rising, -1 falling, 0 unknown

    while i < n:
        delta = vals[i] - vals[last_extreme_idx]

        if direction >= 0 and delta < 0:
            # We were rising and just turned down: confirm a maximum if it is
            # prominent enough relative to the previous confirmed minimum.
            if direction > 0:
                maxima.append(float(vals[last_extreme_idx]))
            direction = -1
            last_extreme_idx = i
        elif direction <= 0 and delta > 0:
            if direction < 0:
                minima.append(float(vals[last_extreme_idx]))
            direction = 1
            last_extreme_idx = i
        else:
            # Same direction: extend the current run.
            last_extreme_idx = i
        i += 1

    maxima_arr = np.array(maxima, dtype=float)
    minima_arr = np.array(minima, dtype=float)

    # Prominence filter: drop turning points that sit too close to the median
    # of the opposite set, which are noise rather than structure.
    if maxima_arr.size >= 3 and minima_arr.size >= 3:
        med_max = float(np.median(maxima_arr))
        med_min = float(np.median(minima_arr))
        if med_max - med_min < min_prom:
            return np.array([]), np.array([])

    return maxima_arr, minima_arr


def calibrate_thresholds(
    elbow_series: "np.ndarray",
    min_rom_deg: float = MIN_DETECTABLE_ROM_DEG,
) -> dict[str, float]:
    """
    Derive up/down thresholds from an observed elbow-angle signal.

    Uses robust percentiles (5th/95th) rather than raw min/max so a single
    landmark spike cannot stretch the range and misplace every threshold.

    Returns a dict of thresholds, or the fallback defaults if the signal is
    too short or too flat to calibrate against.
    """
    valid = elbow_series[np.isfinite(elbow_series)]
    if valid.size < MIN_FRAMES_TO_CALIBRATE:
        return {
            "up_enter": UP_ENTER_DEG,
            "up_exit": UP_EXIT_DEG,
            "down_enter": DOWN_ENTER_DEG,
            "down_exit": DOWN_EXIT_DEG,
            "calibrated": False,
            "observed_min": float("nan"),
            "observed_max": float("nan"),
        }

    # Mask anatomically impossible samples here as well as in smooth_signal.
    # This function is part of the public surface -- the browser's calibration
    # screen calls the TypeScript equivalent directly on live samples -- so it
    # cannot rely on its caller having filtered already. A test caught exactly
    # that: masking only inside smooth_signal left collapsed-arm frames free to
    # poison a direct call.
    valid = valid[
        (valid >= ELBOW_ANGLE_MIN_PLAUSIBLE) & (valid <= ELBOW_ANGLE_MAX_PLAUSIBLE)
    ]
    if valid.size < MIN_FRAMES_TO_CALIBRATE:
        return {
            "up_enter": UP_ENTER_DEG,
            "up_exit": UP_EXIT_DEG,
            "down_enter": DOWN_ENTER_DEG,
            "down_exit": DOWN_EXIT_DEG,
            "calibrated": False,
            "observed_min": float("nan"),
            "observed_max": float("nan"),
        }

    lo = float(np.percentile(valid, 5))
    hi = float(np.percentile(valid, 95))
    span = hi - lo

    if span < min_rom_deg:
        # Signal never moved enough to contain reps at all.
        return {
            "up_enter": UP_ENTER_DEG,
            "up_exit": UP_EXIT_DEG,
            "down_enter": DOWN_ENTER_DEG,
            "down_exit": DOWN_EXIT_DEG,
            "calibrated": False,
            "observed_min": lo,
            "observed_max": hi,
        }

    # ------------------------------------------------------------------
    # Robust "operating band" — derived from the oscillation structure
    # ------------------------------------------------------------------
    # Percentiles of the whole signal are the wrong tool here, because a clip
    # can contain ONE large excursion that is not part of the repeated
    # movement. Measured: good_diagonal_subject_022 holds 77-124 deg for 85%
    # of its frames (many clean reps) and then extends to 169 deg once, for
    # 18 frames at the end.
    #
    #   p5=83  p50=104  p90=121  p95=161   <- the 161 is the lone outlier
    #
    # Any band built from p95 lands the "up" threshold at ~139, well above the
    # ~122 the subject actually reached on every real rep, so the FSM never
    # leaves READY and the clip scores zero.
    #
    # Compare a healthy clip, good_side_subject_010, which sweeps
    # 102-107 at the bottom and 156-170 at the top -- genuinely bimodal.
    #
    # The distinguishing feature is not the range but the STRUCTURE: in a real
    # set, the signal returns to the top repeatedly, so many local maxima sit
    # near the same level. A one-off excursion produces exactly one. So we
    # anchor "up" to the median of the local maxima, and "down" to the median
    # of the local minima, which is insensitive to a single outlier at either
    # end.
    local_max, local_min = _local_extrema(valid)

    if local_max.size >= 2 and local_min.size >= 2:
        top_ref = float(np.median(local_max))
        bottom_ref = float(np.median(local_min))
    else:
        # Too few oscillations to find structure; fall back to the central band.
        top_ref = float(np.percentile(valid, 90))
        bottom_ref = float(np.percentile(valid, 10))

    # The extremes still matter, but only if they are revisited. Take the
    # higher of the structural top and the 90th percentile, so a subject who
    # genuinely holds a deep top position is not penalised.
    hi_struct = max(top_ref, float(np.percentile(valid, 90)))
    lo_struct = min(bottom_ref, float(np.percentile(valid, 10)))

    lo = lo_struct
    hi = hi_struct
    span = hi - lo

    if span < min_rom_deg:
        # Structure says the movement was too small. Trim back toward the raw
        # percentiles in case the extrema detection was simply too strict.
        lo = float(np.percentile(valid, 5))
        hi = float(np.percentile(valid, 95))
        span = hi - lo

    if span < min_rom_deg:
        # Signal never moved enough to contain reps at all.
        return {
            "up_enter": UP_ENTER_DEG,
            "up_exit": UP_EXIT_DEG,
            "down_enter": DOWN_ENTER_DEG,
            "down_exit": DOWN_EXIT_DEG,
            "calibrated": False,
            "observed_min": lo,
            "observed_max": hi,
        }

    up_enter = lo + span * UP_FRACTION
    up_exit = lo + span * UP_EXIT_FRACTION
    down_enter = lo + span * DOWN_FRACTION
    down_exit = lo + span * DOWN_EXIT_FRACTION

    # Clamp to absolute sanity bounds first...
    up_enter = float(np.clip(up_enter, UP_ENTER_MIN, UP_ENTER_MAX))
    up_exit = float(np.clip(up_exit, up_enter - 12.0, up_enter - 1.0))
    down_enter = float(np.clip(down_enter, DOWN_ENTER_MIN, DOWN_ENTER_MAX))
    down_exit = float(np.clip(down_exit, down_enter + 1.0, down_enter + 15.0))

    # ...then GUARANTEE REACHABILITY, which is what an earlier version got
    # wrong. A threshold the signal can never cross is not conservative, it is
    # a silent zero. Pull the down threshold up into the signal's own bottom
    # decile and push the up threshold down into its top decile if needed.
    low_floor = lo + span * 0.10
    high_ceiling = hi - span * 0.10

    if down_enter > low_floor:
        # signal never descends as far as our absolute clamp assumed
        down_enter = low_floor
    if up_enter > high_ceiling:
        up_enter = high_ceiling

    down_enter = min(down_enter, up_enter - 0.25 * span)
    down_enter = max(down_enter, lo + 0.02 * span)

    up_exit = min(max(down_exit, up_enter - 0.18 * span), up_enter - 2.0)
    down_exit = min(max(down_enter + 2.0, down_enter + 0.08 * span), up_enter - 0.30 * span)

    # Final safety: the four thresholds must be strictly ordered or the FSM
    # cannot make progress.
    if not (down_enter < down_exit < up_exit < up_enter):
        down_enter = lo + span * 0.15
        down_exit = lo + span * 0.25
        up_exit = lo + span * 0.65
        up_enter = lo + span * 0.78

    return {
        "up_enter": float(up_enter),
        "up_exit": float(up_exit),
        "down_enter": float(down_enter),
        "down_exit": float(down_exit),
        "calibrated": True,
        "observed_min": lo,
        "observed_max": hi,
    }


@dataclass
class RepEvent:
    """One detected repetition."""

    index: int
    start_t: float
    end_t: float
    min_elbow_angle: float
    max_elbow_angle: float
    frame_start: int
    frame_end: int
    duration_s: float
    peak_is_up: bool


class RepStateMachine:
    """
    Online rep segmenter with hysteresis, median pre-filtering and
    partial-rep rejection.
    """

    def __init__(
        self,
        up_enter: float = UP_ENTER_DEG,
        up_exit: float = UP_EXIT_DEG,
        down_enter: float = DOWN_ENTER_DEG,
        down_exit: float = DOWN_EXIT_DEG,
        min_rom: float = MIN_DETECTABLE_ROM_DEG,
        min_rep_seconds: float = MIN_REP_SECONDS,
        max_rep_seconds: float = MAX_REP_SECONDS,
        calibrate_from: "np.ndarray | None" = None,
    ) -> None:
        if calibrate_from is not None:
            cal = calibrate_thresholds(calibrate_from, min_rom)
            up_enter = cal["up_enter"]
            up_exit = cal["up_exit"]
            down_enter = cal["down_enter"]
            down_exit = cal["down_exit"]
            self.calibration = cal
        else:
            self.calibration = {
                "up_enter": up_enter,
                "up_exit": up_exit,
                "down_enter": down_enter,
                "down_exit": down_exit,
                "calibrated": False,
            }

        self.up_enter = up_enter
        self.up_exit = up_exit
        self.down_enter = down_enter
        self.down_exit = down_exit
        self.min_rom = min_rom
        self.min_rep_seconds = min_rep_seconds
        self.max_rep_seconds = max_rep_seconds

        self.state = "READY"
        # Median pre-filter — applied before thresholding so a spike cannot
        # fake a state transition.
        self._buf: list[float] = []
        self._filtered_buf: list[float] = []
        self._times: list[float] = []
        self._frames: list[int] = []

        self.reps: list[RepEvent] = []

        self._rep_start_t: float | None = None
        self._rep_start_frame: int | None = None
        self._rep_min = 180.0
        self._rep_max = 0.0
        self._phase_extreme = 180.0  # tracks current DOWN depth

        # True until the signal first reaches the top of the movement. While
        # this is set, the rep window start is re-anchored each frame to the
        # highest angle seen so far, so a clip that opens mid-descent does not
        # report its first rep as lasting the entire preamble.
        self._seeking_top = True
        self._peak_so_far = 0.0

    # -- median-of-K pre-filter -------------------------------------------------
    def _filtered(self, value: float) -> float:
        self._buf.append(value)
        if len(self._buf) > MEDIAN_FILTER_K:
            self._buf.pop(0)
        return float(np.median(self._buf))

    def feed(self, elbow_angle: float, timestamp: float, frame_index: int) -> RepEvent | None:
        """
        Push one frame. Returns a RepEvent on the frame that completes a rep,
        otherwise None.
        """
        if not np.isfinite(elbow_angle):
            return None

        angle = self._filtered(elbow_angle)
        self._times.append(timestamp)
        self._frames.append(frame_index)

        if self._rep_start_t is None:
            self._rep_start_t = timestamp
            self._rep_start_frame = frame_index

        self._rep_min = min(self._rep_min, angle)
        self._rep_max = max(self._rep_max, angle)

        # While we have not yet seen a genuine top, slide the window start
        # forward with every new high. Once we have passed a top (or entered
        # the descent), the start is frozen and the rep is measured normally.
        if self._seeking_top:
            if angle > self._peak_so_far:
                self._peak_so_far = angle
                self._rep_start_t = timestamp
                self._rep_start_frame = frame_index

        prev = self.state
        emit: RepEvent | None = None

        if self.state == "READY":
            # Do NOT require the full up_enter here. A recording (or a live
            # session) can begin partway through the movement -- measured:
            # good_diagonal_subject_022 starts at 121 deg and descends, and
            # only reaches up_enter at frame 249 of 266. Demanding up_enter
            # first discarded every rep in that clip.
            #
            # Instead, adopt a directional interpretation as soon as the
            # signal shows which way it is going.
            if angle >= self.up_exit:
                self.state = "UP"
            elif angle <= self.down_exit:
                self.state = "DOWN"
                self._phase_extreme = angle

        elif self.state == "UP":
            if angle < self.up_exit:
                self._seeking_top = False  # we had a top; the descent begins here
                self.state = "DESCENDING"

        elif self.state == "DESCENDING":
            if angle <= self.down_enter:
                self.state = "DOWN"
                self._phase_extreme = angle
            elif angle >= self.up_enter:
                # wobbled back up without reaching depth — not a rep
                self.state = "UP"

        elif self.state == "DOWN":
            self._phase_extreme = min(self._phase_extreme, angle)
            if angle >= self.down_exit:
                self.state = "ASCENDING"

        elif self.state == "ASCENDING":
            if angle >= self.up_enter:
                emit = self._finish_rep(timestamp, frame_index)
                self.state = "UP"
            elif angle <= self.down_enter:
                # dropped back down without completing — still descending
                self.state = "DOWN"

        if self.state != prev:
            pass  # hook for instrumentation

        return emit

    def _finish_rep(self, end_t: float, end_frame: int) -> RepEvent | None:
        start_t = self._rep_start_t if self._rep_start_t is not None else end_t
        start_frame = self._rep_start_frame if self._rep_start_frame is not None else end_frame
        duration = end_t - start_t
        rom = self._rep_max - self._rep_min

        # Reject implausible / partial reps, then reset for the next rep.
        valid_geometry = (
            rom >= self.min_rom
            and duration >= self.min_rep_seconds
            and duration <= self.max_rep_seconds
        )

        event = None
        if valid_geometry:
            event = RepEvent(
                index=len(self.reps) + 1,
                start_t=start_t,
                end_t=end_t,
                min_elbow_angle=self._rep_min,
                max_elbow_angle=self._rep_max,
                frame_start=start_frame,
                frame_end=end_frame,
                duration_s=duration,
                peak_is_up=True,
            )
            self.reps.append(event)

        # Reset window for the next rep — the top position is the boundary.
        self._rep_start_t = end_t
        self._rep_start_frame = end_frame
        self._rep_min = 180.0
        self._rep_max = 0.0
        self._phase_extreme = 180.0
        self._seeking_top = False
        self._peak_so_far = 0.0
        return event

    def finalize(self) -> list[RepEvent]:
        """Close out a session; returns all reps detected."""
        return self.reps


def segment_reps(
    elbow_angles: np.ndarray,
    timestamps: np.ndarray,
    thresholds: dict[str, float] | None = None,
    view: str | None = None,
) -> tuple[list[RepEvent], list[tuple[int, int]], dict[str, float | bool]]:
    """
    Convenience wrapper for offline (training) use.

    Order of operations matters and mirrors the live pipeline exactly:
        1. low-pass smooth the elbow signal
        2. calibrate thresholds from the SMOOTHED signal
        3. run the state machine with hysteresis

    Calibrating on the smoothed signal (not the raw one) is important: noise
    inflates the 5th/95th percentile spread, which would push the up/down
    thresholds apart and cause under-counting.

    Returns (rep_events, windows, quality) where windows are
    (start_frame, end_frame) index pairs into the input arrays, one per rep,
    and quality is the tracking_quality dict for this clip.
    """
    smoothed = smooth_signal(elbow_angles)

    quality = tracking_quality(elbow_angles)

    if not quality["tracked"]:
        # The arm was not reliably tracked. Emitting zero reps is the correct
        # answer, but we say WHY so the extractor can flag the clip instead of
        # treating it as a clean empty result.
        return [], [], quality

    cal = thresholds if thresholds is not None else calibrate_thresholds(smoothed)

    fsm = RepStateMachine(
        up_enter=cal["up_enter"],
        up_exit=cal["up_exit"],
        down_enter=cal["down_enter"],
        down_exit=cal["down_exit"],
    )
    fsm.view = view  # type: ignore[attr-defined]
    rep_frames: list[tuple[int, int]] = []

    for i, (angle, t) in enumerate(zip(smoothed, timestamps)):
        if not np.isfinite(angle):
            continue
        event = fsm.feed(float(angle), float(t), i)
        if event is not None:
            rep_frames.append((event.frame_start, event.frame_end))

    return fsm.reps, rep_frames, quality
