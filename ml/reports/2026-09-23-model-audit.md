# Form model and vision audit — 2026-09-23

## Decision

Keep the browser's existing 300-tree random forest and 0.58 decision threshold. A candidate selected on grouped development cross-validation performed worse on the four held-out test subjects. No new form-classifier weights were shipped.

## Protocol

- Source: 144 processed videos from 24 subjects. The V2 loader yields 837 development reps from 20 subjects and 205 test reps from subjects 010, 016, 023, and 024.
- Features: 34 movement features; seven capture-quality proxies excluded.
- Candidate comparison: five-fold `GroupKFold` over development subjects only. Thresholds maximized out-of-fold macro F1 with a penalty below 0.65 bad-form recall. Seven prespecified candidates were compared.
- The flexible forest (`n_estimators=300`, `max_depth=7`, `min_samples_leaf=3`, balanced classes) was selected by out-of-fold macro F1 before its test result was examined. The current browser forest has depth 5 and leaf size 4.

| Model | Development OOF macro F1 | Bad-form recall | Subject mean F1 | AUC |
| --- | ---: | ---: | ---: | ---: |
| Current forest architecture, OOF threshold 0.53 | 0.6445 | 0.6567 | 0.5855 | 0.7181 |
| Flexible forest, OOF threshold 0.54 | 0.6663 | 0.6687 | 0.6108 | 0.7347 |
| Extra trees | 0.6610 | 0.6567 | 0.6171 | 0.7251 |
| Regular gradient boosting | 0.6616 | 0.6507 | 0.6253 | 0.7435 |

The selected flexible forest failed the held-out check:

| Model | Test accuracy | Test macro F1 | Bad-form recall | AUC |
| --- | ---: | ---: | ---: | ---: |
| Browser forest at shipped threshold 0.58 | 0.7463 | 0.7412 | 0.7561 | 0.7580 |
| Flexible forest at OOF threshold 0.54 | 0.6634 | 0.6439 | 0.5366 | 0.7463 |

This test set has now been inspected for this experiment. Further model selection against these same four subjects would overfit the evaluation. A larger, newly collected subject-disjoint set, especially phone-camera recordings, is needed to support a future replacement.

## Reliability fixes

- The V2 trainer could select gradient boosting in cross-validation and then always fit and export a random forest. It now refits the selected candidate and supports forest, gradient boosting, and logistic browser exports.
- Binary logistic export previously emitted one coefficient row for class 1 while the browser indexed it as class 0. It now emits explicit rows for both classes; export probabilities match scikit-learn to within `1e-6` in tests.
- The shipped summary generator now reads metrics and threshold from the browser model metadata. `ml/reports/metrics.json` and `ml/models/pushup_form_model.joblib` currently describe a separate later training run (0.46 threshold, 0.6829 test accuracy); they must not be used to describe the browser artifact (0.58 threshold, 0.7463 test accuracy).
- Changing cameras now resets pose filters, side lock, calibration frame history, and the displayed elbow value. This prevents stale observations from the previous camera satisfying alignment checks.

## Verification

- `npm run test:py`: 50 passed.
- `npm run test:js`: 187 passed.
- `npm run typecheck` and `npm run build`: passed.

Live phone rep accuracy and latency were not measured in this audit. The app continues to use the local MediaPipe full pose landmarker; no untested pose-model swap was made.
