import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ForestExport,
  GbmExport,
  LogisticExport,
  ModelExport,
  ModelMetadata,
} from '@ai-pushup-coach/form-engine';
import { FormModel, getFormModel, loadFormModel, setFormModel } from '@ai-pushup-coach/form-engine';

function meta(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    model_type: 'logistic',
    feature_spec_version: 1,
    feature_names: ['f0'],
    n_features: 1,
    decision_threshold: 0.5,
    positive_class: 1,
    positive_class_meaning: 'good',
    train_feature_means: [0],
    ...overrides,
  };
}

const logistic: LogisticExport = { kind: 'logistic', coef: [1, 1], intercept: [0, 0], classes: [0, 1] };

/** One stump: feature 0 <= 0.5 -> 1 good of 4, otherwise 4 good of 4. */
const forest: ForestExport = {
  kind: 'forest',
  classes: [0, 1],
  trees: [
    {
      childrenLeft: [1, -1, -1],
      childrenRight: [2, -1, -1],
      feature: [0, 0, 0],
      threshold: [0.5, 0, 0],
      value: [
        [0, 0],
        [3, 1],
        [0, 4],
      ],
    },
  ],
};

const gbm = (sigmoidIsClass: number): GbmExport => ({
  kind: 'gbm',
  initRaw: 0,
  learningRate: 1,
  classes: [0, 1],
  sigmoidIsClass,
  trees: [
    {
      childrenLeft: [-1],
      childrenRight: [-1],
      feature: [0],
      threshold: [0],
      value: [[2]],
    },
  ],
});

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FormModel validation', () => {
  it('refuses a model trained against a different feature spec', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new FormModel();
    expect(model.load(meta({ feature_spec_version: 2 }), logistic)).toBe(false);
    expect(model.isReady()).toBe(false);
  });

  it('refuses metadata with a nonsensical feature count', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const n of [0, -1, Number.NaN]) {
      expect(new FormModel().load(meta({ n_features: n }), logistic)).toBe(false);
    }
  });

  it('refuses metadata whose feature names disagree with the count', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(new FormModel().load(meta({ n_features: 2, feature_names: ['f0'] }), logistic)).toBe(false);
  });

  it('refuses a GBM export that does not declare its sigmoid class', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exp = { ...gbm(1) } as Partial<GbmExport>;
    delete exp.sigmoidIsClass;
    expect(new FormModel().load(meta({ model_type: 'gbm' }), exp as ModelExport)).toBe(false);
  });

  it('accepts a well-formed export', () => {
    const model = new FormModel();
    expect(model.load(meta(), logistic)).toBe(true);
    expect(model.isReady()).toBe(true);
    expect(model.getMetadata()).not.toBeNull();
    expect(model.getThreshold()).toBe(0.5);
  });

  it('reports the metadata decision threshold, defaulting to 0.5', () => {
    const model = new FormModel();
    expect(model.getThreshold()).toBe(0.5);
    model.load(meta({ decision_threshold: 0.7 }), logistic);
    expect(model.getThreshold()).toBe(0.7);
  });
});

describe('FormModel.predict', () => {
  it('returns null before a model is loaded and for a wrong-sized vector', () => {
    const fresh = new FormModel();
    expect(fresh.predict([1])).toBeNull();

    const model = new FormModel();
    model.load(meta(), logistic);
    expect(model.predict([1, 2])).toBeNull();
  });

  it('scores a logistic export as P(good) and labels it against the threshold', () => {
    const model = new FormModel();
    model.load(meta(), logistic);

    const good = model.predict([2]);
    expect(good?.goodProbability).toBeCloseTo(sigmoid(2), 10);
    expect(good?.label).toBe('good');
    expect(good?.missingFeatureCount).toBe(0);

    const bad = model.predict([-2]);
    expect(bad?.goodProbability).toBeCloseTo(sigmoid(-2), 10);
    expect(bad?.label).toBe('bad');
  });

  it('inverts the logistic output when the positive class means "bad"', () => {
    const asGood = new FormModel();
    asGood.load(meta(), logistic);
    const asBad = new FormModel();
    asBad.load(meta({ positive_class_meaning: 'bad' }), logistic);

    const a = asGood.predict([2])?.goodProbability ?? Number.NaN;
    const b = asBad.predict([2])?.goodProbability ?? Number.NaN;
    expect(a + b).toBeCloseTo(1, 10);
    expect(b).toBeCloseTo(sigmoid(-2), 10);
  });

  it('uses the class-zero coefficient row for an exported good-form logistic model', () => {
    const model = new FormModel();
    const exported: LogisticExport = {
      kind: 'logistic',
      coef: [-1, 1],
      intercept: [0, 0],
      classes: [0, 1],
    };
    expect(model.load(meta({ positive_class: 0, positive_class_meaning: 'P(good form)' }), exported)).toBe(true);
    expect(model.predict([2])?.goodProbability).toBeCloseTo(sigmoid(-2), 10);
  });

  it('walks a forest and averages per-leaf class probabilities', () => {
    const model = new FormModel();
    model.load(meta({ model_type: 'forest' }), forest);

    expect(model.predict([0.2])?.goodProbability).toBeCloseTo(0.25, 10);
    expect(model.predict([0.8])?.goodProbability).toBeCloseTo(1, 10);
    // The split is `<=`, so the boundary belongs to the left child.
    expect(model.predict([0.5])?.goodProbability).toBeCloseTo(0.25, 10);
  });

  it('applies the GBM sigmoid to the declared class, not assumed order', () => {
    const goodIsSigmoid = new FormModel();
    goodIsSigmoid.load(meta({ model_type: 'gbm' }), gbm(1));
    expect(goodIsSigmoid.predict([0])?.goodProbability).toBeCloseTo(sigmoid(2), 10);

    const badIsSigmoid = new FormModel();
    badIsSigmoid.load(meta({ model_type: 'gbm' }), gbm(0));
    expect(badIsSigmoid.predict([0])?.goodProbability).toBeCloseTo(sigmoid(-2), 10);
  });

  it('imputes missing features with the training mean and counts them', () => {
    const model = new FormModel();
    model.load(meta({ train_feature_means: [5] }), logistic);

    const result = model.predict([Number.NaN]);
    expect(result?.missingFeatureCount).toBe(1);
    expect(result?.goodProbability).toBeCloseTo(sigmoid(5), 10);

    expect(model.predict([2])?.missingFeatureCount).toBe(0);
  });
});

describe('loadFormModel', () => {
  it('returns null instead of throwing when the model files are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(loadFormModel('/models')).resolves.toBeNull();
  });

  it('returns null when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    await expect(loadFormModel('/models')).resolves.toBeNull();
  });

  it('loads metadata + weights and publishes the shared instance', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes('metadata') ? meta() : logistic),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const model = await loadFormModel('/models');
    expect(model).not.toBeNull();
    expect(model?.isReady()).toBe(true);
    expect(getFormModel()).toBe(model);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Leave no singleton behind for other suites.
    setFormModel(new FormModel());
  });
});
