# AI Push-Up Coach V2 — Acceptance Specification

**Author**: Agent 1 — V2 Lead Architect  
**Status**: APPROVED  
**Date**: 2026-09-21  

---

## The 25 Acceptance Gates

Every release of V2 must pass the complete 25-gate acceptance suite executed by `node scripts/acceptance-v2.mjs`.

| Gate # | Gate Name | Requirement | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **1** | **Build** | Workspace packages compile cleanly | `scripts/build-packages.mjs` exits 0 |
| **2** | **Typecheck** | Full TypeScript type check | `scripts/typecheck.mjs` exits 0 (0 errors) |
| **3** | **Python tests** | Python test suite passes | `pytest tests/` exits 0 with 0 skips |
| **4** | **Web tests** | Frontend Vitest test suite | `npm --prefix apps/web test` exits 0 |
| **5** | **Model artifact validity** | JSON weights and metadata schema | `pushup_form_model.json` valid structure, metadata features match |
| **6** | **Feature parity** | Cross-language feature parity | TS vs Python feature vectors agree to $< 10^{-5}$ |
| **7** | **Model parity** | Cross-language inference parity | TS runtime vs sklearn predictions agree to $< 10^{-6}$ |
| **8** | **View estimator** | Stable orientation estimation | Correctly identifies front/side/diagonal; hysteresis prevents flickering |
| **9** | **Front rep counting** | Usable front-view clips count reps | Zero-rep failure resolved on front fixtures with bilateral signals |
| **10** | **Side rep counting** | Side-view accuracy maintained | No regression on side fixtures |
| **11** | **Calibration motion gate** | Two-phase calibration gate | Rejects static/no-motion samples; requires demonstrated range of motion |
| **12** | **Adaptive calibration** | Dynamic threshold adaptation | Updates thresholds only at safe rep boundaries; handles fatigue drift |
| **13** | **Dataset replay** | Replay runner on labelled clips | Replay capture $\ge 90\%$, 0 zero-count failures on usable clips |
| **14** | **ML evaluation protocol** | Subject-independent CV | 5-fold GroupKFold by subject on dev data |
| **15** | **Test-set isolation** | Sacred held-out test split | Test subjects (010, 016, 023, 024) never enter model selection |
| **16** | **Uncertainty policy** | 3-state output (GOOD/BAD/UNCERTAIN)| Low confidence or occluded frames produce UNCERTAIN without false INVALID |
| **17** | **Geometry issue detectors**| Deterministic issue diagnostics | Detects SHALLOW_DEPTH, HIP_PIKE, HIP_SAG, LOCKOUT from measured geometry |
| **18** | **Coach state machine** | Non-spamming coaching logic | Respects cooldowns; tracks streaks; acknowledges corrections |
| **19** | **Voice fallback** | SpeechSynthesis fallback | Speech failure or absence never crashes workout session |
| **20** | **No fake data** | Heuristic anti-fabrication scan | Zero hard-coded metric literals; unavailable stats show `--` |
| **21** | **Privacy** | Local processing audit | No camera frames, landmarks, or video blobs uploaded to network |
| **22** | **Offline pose assets** | Local MediaPipe WASM assets | WASM binaries byte-identical to npm package in `public/mediapipe/wasm` |
| **23** | **Offline model artifact** | Public mirror synchronization | `public/models` byte-identical to `ml/models` |
| **24** | **Docs/artifact consistency**| Anti-stale documentation test | Published metrics in README/BUILD_STATUS match `shipped_model_summary.json` |
| **25** | **Production build** | Next.js production build | `next build` compiles successfully and generates all static pages |
