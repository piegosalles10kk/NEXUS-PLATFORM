"""
main.py — Sprint 20.2

Nexus ML Microservice — FastAPI app exposing the ChurnRisk XGBoost scorer.

Endpoints:
  GET  /health                — liveness probe
  POST /predict/churn         — predict churn for one node
  POST /predict/churn/batch   — predict churn for multiple nodes at once
  GET  /model/info            — model metadata (version, feature names)

The model is trained on startup (synthetic data).  For production,
mount a pre-trained .json model or connect to the TimescaleDB hypertable
and retrain periodically via the /model/retrain endpoint (future sprint).
"""

import os
import logging
from contextlib import asynccontextmanager

import redis as redis_lib
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from model import train_model, predict_churn, NUM_FEATURES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Globals ───────────────────────────────────────────────────────────────────

_model = None
_redis: redis_lib.Redis | None = None

FEATURE_NAMES = [
    "cpu_pct",
    "ram_pct",
    "disk_pct",
    "net_rx_mb",
    "net_tx_mb",
    "gpu_pct",
    "uptime_hours",
    "hour_of_day",
]

# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _redis

    log.info("Training ChurnRisk model on synthetic data…")
    _model = train_model()
    log.info("Model ready.")

    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    try:
        _redis = redis_lib.from_url(redis_url, decode_responses=True)
        _redis.ping()
        log.info(f"Redis connected: {redis_url}")
    except Exception as e:
        log.warning(f"Redis not available ({e}) — prediction caching disabled")
        _redis = None

    yield
    log.info("ML service shutting down")


app = FastAPI(
    title="Nexus ML Service",
    version="1.0.0",
    description="ChurnRisk XGBoost scorer for DePIN nodes (Sprint 20.2)",
    lifespan=lifespan,
)

# ── Schemas ───────────────────────────────────────────────────────────────────

class ChurnRequest(BaseModel):
    node_id:      str   = Field(..., description="Node UUID")
    cpu_pct:      float = Field(0.0,  ge=0, le=100)
    ram_pct:      float = Field(0.0,  ge=0, le=100)
    disk_pct:     float = Field(0.0,  ge=0, le=100)
    net_rx_mb:    float = Field(0.0,  ge=0)
    net_tx_mb:    float = Field(0.0,  ge=0)
    gpu_pct:      float = Field(0.0,  ge=0, le=100)
    uptime_hours: float = Field(0.0,  ge=0)
    hour_of_day:  float = Field(0.0,  ge=0, le=23)


class ChurnResponse(BaseModel):
    node_id:    str
    churn_prob: float
    churn_risk: str   # LOW | MEDIUM | HIGH


class BatchChurnRequest(BaseModel):
    nodes: list[ChurnRequest]


class BatchChurnResponse(BaseModel):
    results: list[ChurnResponse]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model is not None}


@app.get("/model/info")
def model_info():
    return {
        "version":       "1.0.0",
        "algorithm":     "XGBClassifier",
        "num_features":  NUM_FEATURES,
        "feature_names": FEATURE_NAMES,
        "output":        "churn_prob (0-1), churn_risk (LOW|MEDIUM|HIGH)",
    }


@app.post("/predict/churn", response_model=ChurnResponse)
def predict_churn_endpoint(req: ChurnRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    features = [
        req.cpu_pct,
        req.ram_pct,
        req.disk_pct,
        req.net_rx_mb,
        req.net_tx_mb,
        req.gpu_pct,
        min(req.uptime_hours, 720),
        req.hour_of_day,
    ]

    result = predict_churn(_model, features)

    # Cache result in Redis for 60 s (optional — for dashboard polling)
    if _redis is not None:
        try:
            import json
            _redis.setex(
                f"nexus:ml:churn:{req.node_id}",
                60,
                json.dumps(result),
            )
        except Exception:
            pass

    return ChurnResponse(
        node_id=req.node_id,
        churn_prob=result["churn_prob"],
        churn_risk=result["churn_risk"],
    )


@app.post("/predict/churn/batch", response_model=BatchChurnResponse)
def predict_churn_batch(req: BatchChurnRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    if not req.nodes:
        return BatchChurnResponse(results=[])

    results = []
    for node in req.nodes:
        features = [
            node.cpu_pct,
            node.ram_pct,
            node.disk_pct,
            node.net_rx_mb,
            node.net_tx_mb,
            node.gpu_pct,
            min(node.uptime_hours, 720),
            node.hour_of_day,
        ]
        r = predict_churn(_model, features)
        results.append(ChurnResponse(
            node_id=node.node_id,
            churn_prob=r["churn_prob"],
            churn_risk=r["churn_risk"],
        ))

    return BatchChurnResponse(results=results)


# ── Entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8500, reload=False)
