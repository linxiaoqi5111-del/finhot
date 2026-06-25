"""Local OpenAI-compatible embeddings server backed by BAAI/bge-m3.

Exposes POST /v1/embeddings so the FinHot app (rss-proxy server-side enrichment,
or App Settings -> AI -> Embedding "Custom" preset) can generate embeddings
locally with zero API-token cost. Vectors are dense 1024-d, L2-normalized
(matching the knowledge-base RAG embedder).

Run: see run.sh / com.finhot.embed.plist in this directory.
"""
import os
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Union

MODEL_NAME = os.environ.get("BGE_MODEL", "BAAI/bge-m3")
MAX_LENGTH = int(os.environ.get("BGE_MAX_LENGTH", "2048"))

app = FastAPI(title="finhot-embed", version="1.0")
_model = None


def get_model():
    global _model
    if _model is None:
        from FlagEmbedding import BGEM3FlagModel
        # CPU: fp16 unsupported, keep full precision.
        _model = BGEM3FlagModel(MODEL_NAME, use_fp16=False)
    return _model


def _l2(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = "bge-m3"


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "dimension": 1024}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "bge-m3", "object": "model"}]}


@app.post("/v1/embeddings")
def embeddings(req: EmbeddingRequest):
    texts = [req.input] if isinstance(req.input, str) else list(req.input)
    out = get_model().encode(
        texts, batch_size=8, max_length=MAX_LENGTH,
        return_dense=True, return_sparse=False, return_colbert_vecs=False,
    )
    vecs = _l2(np.asarray(out["dense_vecs"], dtype=np.float32))
    data = [
        {"object": "embedding", "index": i, "embedding": vecs[i].tolist()}
        for i in range(len(texts))
    ]
    total = sum(len(t) for t in texts)
    return {
        "object": "list",
        "data": data,
        "model": req.model or "bge-m3",
        "usage": {"prompt_tokens": total, "total_tokens": total},
    }
