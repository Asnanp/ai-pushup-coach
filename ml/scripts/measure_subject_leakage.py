"""
ml/scripts/measure_subject_leakage.py

Agent 7 — FEATURE ENGINEER & Agent 19 — DIAGNOSTICS

Diagnostic tool to measure how much personal identity (subject fingerprint)
is leaked into the feature representations.
Trains an auxiliary subject classifier on the development subjects' rep vectors.
Compares V1 37-feature representations with candidate V2 representations.
"""

import glob
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler

PROCESSED_DIR = Path("ml/data/processed")
TEST_SUBJECTS = {"010", "016", "023", "024"}

def load_development_dataset():
    X_list = []
    y_subject = []
    y_label = []
    rep_sources = []
    
    for p in sorted(PROCESSED_DIR.glob("*.npz")):
        data = np.load(p, allow_pickle=True)
        sub = str(data["subject"]) if "subject" in data else p.stem.split("_")[-1]
        if sub in TEST_SUBJECTS:
            continue  # Keep test subjects sacred
            
        reps = data["rep_vectors"]
        label = 0 if "good" in p.stem else 1
        
        for r in reps:
            if np.all(np.isfinite(r)):
                X_list.append(r)
                y_subject.append(sub)
                y_label.append(label)
                rep_sources.append(p.stem)
                
    X = np.array(X_list, dtype=float)
    y_sub = np.array(y_subject)
    y_lab = np.array(y_label)
    return X, y_sub, y_lab, rep_sources

def evaluate_subject_leakage(X, y_sub, feature_names=None):
    # Standardize
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    
    # 5-fold stratified CV for subject prediction
    clf = RandomForestClassifier(n_estimators=100, random_state=42, max_depth=8)
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    scores = cross_val_score(clf, X_scaled, y_sub, cv=skf, scoring="accuracy")
    
    clf.fit(X_scaled, y_sub)
    importances = clf.feature_importances_
    
    top_leaking = []
    if feature_names and len(feature_names) == len(importances):
        ranked = sorted(zip(feature_names, importances), key=lambda x: x[1], reverse=True)
        top_leaking = [{"feature": f, "importance": round(float(imp), 4)} for f, imp in ranked[:10]]
        
    return {
        "n_samples": int(len(X)),
        "n_subjects": int(len(set(y_sub))),
        "random_guess_accuracy": round(1.0 / len(set(y_sub)), 4),
        "subject_prediction_accuracy_mean": round(float(np.mean(scores)), 4),
        "subject_prediction_accuracy_std": round(float(np.std(scores)), 4),
        "fold_accuracies": [round(float(s), 4) for s in scores],
        "top_leaking_features": top_leaking,
    }

def main():
    X, y_sub, y_lab, _ = load_development_dataset()
    print(f"Loaded {len(X)} rep samples across {len(set(y_sub))} development subjects.")
    
    from ml.src.features import FEATURE_NAMES
    
    leakage_v1 = evaluate_subject_leakage(X, y_sub, FEATURE_NAMES)
    print("\n--- SUBJECT LEAKAGE DIAGNOSTIC (V1 FEATURES) ---")
    print(f"Random Guess Baseline: {leakage_v1['random_guess_accuracy']:.2%}")
    print(f"Subject Prediction Accuracy: {leakage_v1['subject_prediction_accuracy_mean']:.2%} (+/- {leakage_v1['subject_prediction_accuracy_std']:.2%})")
    print("\nTop Leaking Features (highest subject specificity):")
    for item in leakage_v1["top_leaking_features"][:7]:
        print(f"  - {item['feature']}: {item['importance']:.4f}")
        
    report_path = Path("ml/reports/subject_leakage_diagnostic.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({"v1_leakage": leakage_v1}, f, indent=2)
    print(f"\nWrote diagnostic report to {report_path}")

if __name__ == "__main__":
    main()
