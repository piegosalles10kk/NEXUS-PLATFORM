"""
model.py — Sprint 20.2

ChurnRisk XGBoost scorer.

The model predicts the probability that a DePIN node will go offline
("churn") within the next 30 minutes based on recent telemetry features.

Features (8 total — same as the FedAvg logistic regression in trainer.go):
  0. cpu_pct       — CPU utilisation 0-100
  1. ram_pct       — RAM utilisation 0-100
  2. disk_pct      — Disk utilisation 0-100
  3. net_rx_mb     — Network received MB/s (avg last 5 min)
  4. net_tx_mb     — Network transmitted MB/s (avg last 5 min)
  5. gpu_pct       — GPU utilisation 0-100 (0 for CPU-only nodes)
  6. uptime_hours  — Node uptime in hours (capped at 720)
  7. hour_of_day   — UTC hour 0-23

Output:
  churn_prob — float 0-1 (probability of churn within 30 min)
  churn_risk — "LOW" | "MEDIUM" | "HIGH"

Bootstrap:
  The model is trained on synthetic data with a skewed label distribution
  (95% stable, 5% churn) to mimic real DePIN node behaviour.
  In production, replace the synthetic dataset with real telemetry from
  the TimescaleDB hypertable (Sprint 20.1).
"""

import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split

NUM_FEATURES = 8
RANDOM_SEED  = 42


def _generate_synthetic_dataset(n: int = 10_000):
    """Generate synthetic training data."""
    rng = np.random.default_rng(RANDOM_SEED)

    cpu_pct      = rng.uniform(0, 100, n)
    ram_pct      = rng.uniform(10, 100, n)
    disk_pct     = rng.uniform(5, 95, n)
    net_rx_mb    = np.abs(rng.normal(1.0, 0.5, n))
    net_tx_mb    = np.abs(rng.normal(0.5, 0.3, n))
    gpu_pct      = rng.uniform(0, 100, n)
    uptime_hours = np.clip(rng.exponential(200, n), 0, 720)
    hour_of_day  = rng.integers(0, 24, n).astype(float)

    X = np.column_stack([
        cpu_pct, ram_pct, disk_pct,
        net_rx_mb, net_tx_mb, gpu_pct,
        uptime_hours, hour_of_day,
    ])

    # Churn label: 1 if CPU > 90 or RAM > 95 or disk > 90 (with noise)
    base_risk = (
        (cpu_pct > 90).astype(float) * 0.5  +
        (ram_pct > 95).astype(float) * 0.4  +
        (disk_pct > 90).astype(float) * 0.1
    )
    noise = rng.uniform(0, 0.15, n)
    y = (base_risk + noise > 0.45).astype(int)

    return X, y


def train_model() -> xgb.XGBClassifier:
    """Train a binary XGBoost classifier on synthetic data."""
    X, y = _generate_synthetic_dataset()
    X_train, _, y_train, _ = train_test_split(X, y, test_size=0.2, random_state=RANDOM_SEED)

    model = xgb.XGBClassifier(
        n_estimators=100,
        max_depth=4,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        use_label_encoder=False,
        eval_metric='logloss',
        random_state=RANDOM_SEED,
    )
    model.fit(X_train, y_train)
    return model


def predict_churn(model: xgb.XGBClassifier, features: list[float]) -> dict:
    """
    Predict churn risk for a single node.

    Args:
        features: list of 8 floats in the order defined above.

    Returns:
        dict with keys: churn_prob (float), churn_risk (str)
    """
    arr = np.array(features, dtype=float).reshape(1, -1)
    if arr.shape[1] != NUM_FEATURES:
        raise ValueError(f"Expected {NUM_FEATURES} features, got {arr.shape[1]}")

    prob = float(model.predict_proba(arr)[0][1])

    if prob < 0.25:
        risk = "LOW"
    elif prob < 0.60:
        risk = "MEDIUM"
    else:
        risk = "HIGH"

    return {"churn_prob": round(prob, 4), "churn_risk": risk}
