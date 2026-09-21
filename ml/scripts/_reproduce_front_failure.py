"""
Reproduce front-camera rep counting failure in V1.

Inspects the 48 front clips in ml/data/processed/ and analyzes why
13 of them produced 0 reps, and why live calibration (tsLive) fails completely.
"""
import glob
import os
import sys
import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from ml.src.rep_segmenter import calibrate_thresholds, smooth_signal, segment_reps

def main():
    front_files = sorted(glob.glob("ml/data/processed/*_front_*.npz"))
    print(f"Total front clips: {len(front_files)}")
    
    zero_clips = []
    low_span_clips = []
    unbalanced_clips = []
    
    for p in front_files:
        name = os.path.splitext(os.path.basename(p))[0]
        data = np.load(p, allow_pickle=True)
        frames = data["frames"]
        times = data["frame_times"]
        cols = [str(c) for c in data["frame_columns"]]
        
        i_el = cols.index("elbow_angle")
        i_elo = cols.index("elbow_angle_opposite")
        i_valid = cols.index("valid")
        i_vis = cols.index("mean_visibility")
        
        el = frames[:, i_el].copy()
        elo = frames[:, i_elo].copy()
        valid = frames[:, i_valid] > 0.5
        
        reps = len(data["rep_meta"])
        
        # Test Python segmenter directly
        ev, win, tq = segment_reps(el, times, view="front")
        
        # Check both elbows
        finite_el = el[np.isfinite(el) & valid]
        finite_elo = elo[np.isfinite(elo) & valid]
        
        span_el = (np.percentile(finite_el, 95) - np.percentile(finite_el, 5)) if len(finite_el) > 10 else 0
        span_elo = (np.percentile(finite_elo, 95) - np.percentile(finite_elo, 5)) if len(finite_elo) > 10 else 0
        
        # Check bilateral combined: max of both or mean of both
        if len(finite_el) > 10 and len(finite_elo) > 10:
            both = np.maximum(el, elo)
            both_finite = both[np.isfinite(both) & valid]
            span_both = (np.percentile(both_finite, 95) - np.percentile(both_finite, 5)) if len(both_finite) > 10 else 0
        else:
            span_both = 0
            
        is_zero = len(win) == 0
        if is_zero:
            zero_clips.append((name, reps, len(win), span_el, span_elo, span_both, tq))
            
    print("\n--- DETAILED DIAGNOSTIC FOR TRACKED ZERO-REP CLIPS ---")
    for name in ["bad_front_subject_009", "bad_front_subject_014", "bad_front_subject_022", "good_front_subject_021"]:
        d = np.load(f"ml/data/processed/{name}.npz", allow_pickle=True)
        el = d["frames"][:, 0].copy()
        valid = d["frames"][:, 16] > 0.5
        sm = smooth_signal(np.where(valid, el, np.nan))
        thr = calibrate_thresholds(sm)
        from ml.src.rep_segmenter import RepStateMachine
        fsm = RepStateMachine(
            up_enter=thr["up_enter"],
            up_exit=thr["up_exit"],
            down_enter=thr["down_enter"],
            down_exit=thr["down_exit"],
        )
        for i, (val, t) in enumerate(zip(sm, d["frame_times"])):
            if np.isfinite(val):
                fsm.feed(float(val), float(t), i)
        ev = fsm.reps
        win = [(r.frame_start, r.frame_end) for r in ev]
        sm_finite = sm[np.isfinite(sm)]
        p5, p50, p95 = np.percentile(sm_finite, [5, 50, 95])
        print(f"{name:25s} sm_p5={p5:5.1f} sm_p95={p95:5.1f} upE={thr.get('up_enter', 0):5.1f} upX={thr.get('up_exit', 0):5.1f} dnE={thr.get('down_enter', 0):5.1f} dnX={thr.get('down_exit', 0):5.1f} events={len(ev)} windows={len(win)}")
        # Check why FSM didn't produce reps
        # Let's simulate FSM state transitions
        state = 'READY'
        states = []
        for i, val in enumerate(sm):
            if not np.isfinite(val): continue
            old_st = state
            if state == 'READY':
                if val >= thr['up_exit']: state = 'UP'
                elif val <= thr['down_exit']: state = 'DOWN'
            elif state == 'UP':
                if val < thr['up_exit']: state = 'DESCENDING'
            elif state == 'DESCENDING':
                if val <= thr['down_enter']: state = 'DOWN'
                elif val >= thr['up_enter']: state = 'UP'
            elif state == 'DOWN':
                if val >= thr['down_exit']: state = 'ASCENDING'
            elif state == 'ASCENDING':
                if val >= thr['up_enter']: state = 'UP'
                elif val <= thr['down_enter']: state = 'DOWN'
            if state != old_st:
                states.append((i, f"{old_st}->{state}", val))
        print(f"  Transitions ({len(states)}): {states[:10]}")

if __name__ == "__main__":
    main()

