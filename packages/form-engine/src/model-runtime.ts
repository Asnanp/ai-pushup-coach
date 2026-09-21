/**
 * packages/form-engine/model-runtime.ts
 *
 * Agent 13 — REAL-TIME ML INFERENCE ENGINEER
 *
 * Loads the exported model (pure JSON, no dependency) and scores feature
 * vectors in the browser.
 *
 * Why in-browser inference is the primary path rather than the FastAPI
 * service:
 *   - camera frames never leave the device (privacy requirement),
 *   - zero network latency in the rep loop,
 *   - the demo cannot be broken by venue wifi.
 * The API exists as a fallback and for batch evaluation.
 *
 * Supported export formats (see docs/MODEL_CONTRACT.md §6):
 *   - 'logistic'  : coef_ + intercept_, scored by dot product
 *   - 'forest'    : per-tree node arrays, scored by traversal
 *   - 'gbm'       : init + per-stage regression trees (sklearn GradientBoosting)
 */

import type { FormLabel } from '@ai-pushup-coach/types';

export const FEATURE_SPEC_VERSION = 1;

/**
 * Label encoding used by the training pipeline (`ml/scripts/train_classifier.py`).
 *
 * sklearn's `LabelEncoder` mapped the string labels to integers in sorted
 * order, so 'bad' -> 0 and 'good' -> 1. The exported JSON therefore carries
 * numeric class values; the runtime translates them here rather than assuming
 * the export used strings.
 */
export const CLASS_BAD = 0;
export const CLASS_GOOD = 1;

/** Which exported class index corresponds to "good form". */
export const POSITIVE_CLASS = CLASS_GOOD;

export interface ModelTree {
  childrenLeft: number[];
  childrenRight: number[];
  feature: number[];
  threshold: number[];
  /**
   * For classification forests: per-leaf class counts [n_bad, n_good].
   * For GBMs: a single regression value per leaf.
   */
  value: number[][];
}

export interface LogisticExport {
  kind: 'logistic';
  coef: number[];
  intercept: number[];
  /** Class ordering of the coefficient rows (sklearn `classes_`). */
  classes: number[];
}

export interface ForestExport {
  kind: 'forest';
  trees: ModelTree[];
  /** Class ordering of the per-leaf count columns (sklearn `classes_`). */
  classes: number[];
}

export interface GbmExport {
  kind: 'gbm';
  initRaw: number;
  learningRate: number;
  trees: ModelTree[];
  classes: number[];
  /**
   * The class the sigmoid output refers to.
   *
   * sklearn's binary `GradientBoostingClassifier` fits its stage trees to the
   * POSITIVE class, which after `LabelEncoder` is index 1 ('good'). The raw
   * sigmoid therefore yields P(good). If a future export trains on a
   * differently-ordered class vector this field changes, and the runtime
   * inverts rather than silently scoring every rep backwards.
   */
  sigmoidIsClass?: number;
}

export type ModelExport = LogisticExport | ForestExport | GbmExport;

export interface ModelMetadata {
  model_type: string;
  feature_spec_version: number;
  feature_names: string[];
  /** Number of features the MODEL consumes (may be a subset of the contract). */
  n_features: number;
  /** Size of the feature contract in docs/FEATURE_SCHEMA.md (37). */
  n_features_contract?: number;
  decision_threshold: number;
  /**
   * Class index this model treats as the positive outcome. The training
   * pipeline encodes 'good' as 1; the meaning is spelled out separately in
   * `positive_class_meaning` so the runtime never has to guess.
   */
  positive_class: number | string;
  positive_class_meaning?: string;
  /** Features deliberately withheld from the model, with the reason recorded. */
  excluded_capture_features?: string[];
  trained_at?: string;
  metrics?: Record<string, unknown>;
  train_feature_means?: number[];
  train_feature_stds?: number[];
}

export interface PredictionResult {
  goodProbability: number;
  label: FormLabel;
  missingFeatureCount: number;
}

/** Walk one tree, returning the leaf index. */
function traverse(tree: ModelTree, x: Float64Array | number[]): number {
  let node = 0;
  // Depth guard: a malformed export must not hang the rAF loop.
  for (let guard = 0; guard < 200; guard++) {
    const left = tree.childrenLeft[node];
    if (left === -1) return node; // leaf
    const feat = tree.feature[node];
    const thr = tree.threshold[node];
    node = x[feat] <= thr ? left : tree.childrenRight[node];
  }
  return node;
}

export class FormModel {
  private exp: ModelExport | null = null;
  private meta: ModelMetadata | null = null;
  private ready = false;

  /** Load metadata + weights. Returns false if unusable. */
  load(meta: ModelMetadata, exp: ModelExport): boolean {
    this.meta = meta;
    this.exp = exp;
    this.ready = this.validate();
    return this.ready;
  }

  isReady(): boolean {
    return this.ready;
  }

  getMetadata(): ModelMetadata | null {
    return this.meta;
  }

  getThreshold(): number {
    return this.meta?.decision_threshold ?? 0.5;
  }

  /**
   * Hard guardrails (docs/MODEL_CONTRACT.md §8).
   * A feature-spec mismatch means the model was trained on a different vector
   * layout — scoring with it would produce confident nonsense. Refuse instead.
   */
  private validate(): boolean {
    if (!this.meta || !this.exp) return false;

    if (this.meta.feature_spec_version !== FEATURE_SPEC_VERSION) {
      console.error(
        `[FormModel] feature_spec_version mismatch: model=${this.meta.feature_spec_version} ` +
          `runtime=${FEATURE_SPEC_VERSION}. Refusing to load.`,
      );
      return false;
    }

    const n = this.meta.n_features;
    if (!Number.isFinite(n) || n <= 0) return false;

    const expectedNames = this.meta.feature_names;
    if (!Array.isArray(expectedNames) || expectedNames.length !== n) return false;

    // A GBM export without sigmoidIsClass cannot be interpreted safely: the
    // runtime would have to guess whether the sigmoid means P(good) or P(bad),
    // and guessing wrong inverts every prediction. Refuse rather than guess.
    if (this.exp.kind === 'gbm' && typeof this.exp.sigmoidIsClass !== 'number') {
      console.error(
        '[FormModel] GBM export is missing `sigmoidIsClass`. Re-run ' +
          'ml/scripts/export_model.py; the runtime will not guess class semantics.',
      );
      return false;
    }

    return true;
  }

  /**
   * Score one feature vector.
   *
   * Non-finite features are imputed with the training mean and counted. If
   * more than 3 features required imputation the caller is expected to mark
   * the rep `unknown` rather than trust the output.
   */
  predict(vector: Float64Array | number[]): PredictionResult | null {
    if (!this.ready || !this.exp || !this.meta) return null;

    const n = this.meta.n_features;
    if (vector.length !== n) return null;

    // Impute non-finite values with the training mean.
    const x = new Float64Array(n);
    let missing = 0;
    const means = this.meta.train_feature_means ?? [];
    for (let i = 0; i < n; i++) {
      const v = vector[i];
      if (Number.isFinite(v)) {
        x[i] = v;
      } else {
        x[i] = Number.isFinite(means[i]) ? means[i] : 0;
        missing++;
      }
    }

    let goodProb: number;
    switch (this.exp.kind) {
      case 'logistic':
        goodProb = this.scoreLogistic(this.exp, x);
        break;
      case 'forest':
        goodProb = this.scoreForest(this.exp, x);
        break;
      case 'gbm':
        goodProb = this.scoreGbm(this.exp, x);
        break;
      default:
        return null;
    }

    goodProb = Math.max(0, Math.min(1, goodProb));
    const label: FormLabel =
      goodProb >= this.meta.decision_threshold ? 'good' : 'bad';

    return { goodProbability: goodProb, label, missingFeatureCount: missing };
  }

  /**
   * Resolve the metadata's `positive_class` to a numeric class index, and
   * report whether that index means "good form".
   *
   * The metadata states both the index and its meaning. We trust the explicit
   * meaning when present, because the index alone is not self-describing: an
   * export could legitimately encode 'good' as 0.
   */
  private resolvePositiveClass(): { index: number; isGood: boolean } {
    const declared = this.meta?.positive_class;
    const meaning = String(this.meta?.positive_class_meaning ?? '').toLowerCase();

    let index: number;
    if (typeof declared === 'number' && Number.isFinite(declared)) {
      index = declared;
    } else if (declared === 'good' || declared === 'bad') {
      index = declared === 'good' ? CLASS_GOOD : CLASS_BAD;
    } else {
      index = POSITIVE_CLASS;
    }

    // `positive_class_meaning` is the authority on what the positive class IS.
    // Fall back to the numeric convention only when it is absent.
    const isGood = meaning.includes('good') ? true : meaning.includes('bad') ? false : index === CLASS_GOOD;

    return { index, isGood };
  }

  /** P(good) = sigmoid(w . x + b) */
  private scoreLogistic(exp: LogisticExport, x: Float64Array): number {
    const { index, isGood } = this.resolvePositiveClass();
    const row = this.rowForClass(exp.classes, index);
    let z = exp.intercept[row] ?? 0;
    const coef = exp.coef;
    for (let i = 0; i < x.length; i++) z += coef[row * x.length + i] * x[i];
    const p = 1 / (1 + Math.exp(-z));
    return isGood ? p : 1 - p;
  }

  /**
   * Find the coefficient row / count column for a class index.
   * Falls back to position 0 when the export omits `classes`.
   */
  private rowForClass(classes: number[] | undefined, index: number): number {
    if (!Array.isArray(classes) || classes.length === 0) return 0;
    const found = classes.indexOf(index);
    return found >= 0 ? found : 0;
  }

  /** Average of per-tree class probabilities. */
  private scoreForest(exp: ForestExport, x: Float64Array): number {
    const { index, isGood } = this.resolvePositiveClass();
    if (exp.trees.length === 0) return 0.5;

    const posIdx = this.rowForClass(exp.classes, index);

    let sum = 0;
    for (const tree of exp.trees) {
      const leaf = traverse(tree, x);
      const counts = tree.value[leaf] ?? [];
      const total = counts.reduce((a, b) => a + b, 0);
      sum += total > 0 ? (counts[posIdx] ?? 0) / total : 0.5;
    }
    const p = sum / exp.trees.length;
    return isGood ? p : 1 - p;
  }

  /**
   * sklearn GradientBoostingClassifier with binary log-loss:
   * raw = init + lr * sum(tree outputs), then sigmoid.
   *
   * IMPORTANT: the sigmoid yields the probability of `exp.sigmoidIsClass`,
   * NOT automatically of "good". sklearn fits the binary stage trees to
   * `classes_[1]`, which is 'good' (index 1) for this project's label
   * encoding — but the export records the value so this code does not depend
   * on that coincidence. Getting this wrong returns the exact complement and
   * reports every good rep as bad.
   */
  private scoreGbm(exp: GbmExport, x: Float64Array): number {
    let raw = exp.initRaw;
    for (const tree of exp.trees) {
      const leaf = traverse(tree, x);
      const v = tree.value[leaf];
      raw += exp.learningRate * (Array.isArray(v) ? v[0] : (v as unknown as number));
    }
    const p = 1 / (1 + Math.exp(-raw));

    const { index, isGood } = this.resolvePositiveClass();
    const sigmoidIsClass =
      typeof exp.sigmoidIsClass === 'number' && Number.isFinite(exp.sigmoidIsClass)
        ? exp.sigmoidIsClass
        : this.rowForClass(exp.classes, CLASS_GOOD);

    // Two independent things can flip the answer: the sigmoid may refer to a
    // class other than the configured positive one, and the positive class may
    // itself be "bad". Compose them rather than assuming either cancels out.
    const sigmoidIsPositive = sigmoidIsClass === index;
    const wantGood = isGood ? sigmoidIsPositive : !sigmoidIsPositive;
    return wantGood ? p : 1 - p;
  }
}

/** Process-wide singleton so the model is fetched once. */
let sharedModel: FormModel | null = null;

export function getFormModel(): FormModel | null {
  return sharedModel;
}

export function setFormModel(model: FormModel): void {
  sharedModel = model;
}

/**
 * Fetch and load the model from /models/. Silent-failure-safe: if anything is
 * missing the app falls back to geometry-only scoring and says so in the UI.
 */
export async function loadFormModel(basePath = '/models'): Promise<FormModel | null> {
  try {
    const [metaRes, expRes] = await Promise.all([
      fetch(`${basePath}/pushup_form_model.metadata.json`),
      fetch(`${basePath}/pushup_form_model.json`),
    ]);

    if (!metaRes.ok || !expRes.ok) return null;

    const meta = (await metaRes.json()) as ModelMetadata;
    const exp = (await expRes.json()) as ModelExport;

    const model = new FormModel();
    if (!model.load(meta, exp)) return null;

    sharedModel = model;
    return model;
  } catch {
    return null;
  }
}
