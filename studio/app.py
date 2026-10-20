"""d3 Studio — same-origin FastAPI app with the d3-turbo runtime embedded.

A laya-studio-style studio for vllm-sr/d3-turbo (Decision 3.0), served by the
vllm-srun runtime in one process:

* ``GET /api/examples`` — the curated deck catalog (``examples.json``);
* ``GET /api/status`` · ``GET /api/ready`` — runtime readiness (503 while the
  model is loading, per the runtime's own health lifecycle);
* ``POST /api/evaluate`` — loose internal endpoint, proxied to the runtime's
  ``/v1/systemone`` (which natively answers multi-question and multi-state
  requests in one call — the state-once superpower);
* the runtime ASGI app is mounted behind the studio routes and answers the
  contract itself: ``POST /v1/systemone`` (Choice / Noul / Score, plus d3-turbo's
  Box and Track, with images and videos as data URLs and assets by reference),
  ``GET /v1/models``, ``GET /health``, ``GET /health/live``, ``GET /metrics``.

The runtime loads in a background thread at app creation, so the pod comes up
and answers ``/api/ready`` 503 while the weights arrive. Requests and results
are not application-logged.

Configuration is by environment variable:

* ``D3_MODEL_DIR`` — local package directory (the tiny turbo fixture; takes
  precedence when set);
* ``D3_MODEL`` (default ``vllm-sr/d3-turbo``) and ``D3_REVISION`` (default the
  pinned release revision) — the hub model to serve otherwise;
* ``D3_DEVICE`` (default ``auto``) — cpu, cuda or auto;
* ``D3_THREADS`` — CPU threads for the model;
* ``D3_OFFLINE`` (default ``0``) — serve from the local cache only (the
  container sets this: the init pull already fetched the weights);
* ``D3_SERVED_NAME`` (default ``d3-turbo``) — the model ID reported by the API.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from vllm_srun.api.app import OPENAPI_PATH as RUNTIME_OPENAPI_PATH
from vllm_srun.api.app import create_app as create_runtime_app
from vllm_srun.config import ModelConfig, ServeConfig
from vllm_srun.runtime import Runtime

from .contract import load_decks, public_limits

ROOT = Path(__file__).resolve().parent
_log = logging.getLogger("d3.studio")

DEFAULT_MODEL = "vllm-sr/d3-turbo"
# The Decision 3.0 release the studio pins (vllm_srun's built-in registry
# verifies every file digest against this revision's manifest at load).
DEFAULT_REVISION = "689b3af198baaf6f11110be38a9daa7188dfd8ad"
DEFAULT_SERVED_NAME = "d3-turbo"


def env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def model_spec() -> dict[str, Any]:
    """What the studio is configured to serve, for /api/status."""
    model_dir = os.environ.get("D3_MODEL_DIR", "").strip()
    if model_dir:
        return {"source": "package", "dir": model_dir}
    return {
        "source": "hub",
        "model": os.environ.get("D3_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "revision": os.environ.get("D3_REVISION", DEFAULT_REVISION).strip(),
    }


def build_runtime() -> Runtime:
    """Build the runtime from the environment. The model loads in a background
    thread (``start(background=True)``); readiness follows ``/api/ready``."""
    spec = model_spec()
    device = os.environ.get("D3_DEVICE", "auto").strip() or "auto"
    threads = os.environ.get("D3_THREADS", "").strip()
    mc = ModelConfig(
        model=spec.get("dir") or spec.get("model", DEFAULT_MODEL),
        revision=spec.get("revision") if spec["source"] == "hub" else None,
        name=os.environ.get("D3_SERVED_NAME", DEFAULT_SERVED_NAME).strip() or DEFAULT_SERVED_NAME,
        device=device,
        engine="native",
    )
    cfg = ServeConfig(
        models=(mc,),
        offline=env_flag("D3_OFFLINE"),
        threads=int(threads) if threads.isdigit() and int(threads) > 0 else None,
    )
    return Runtime(cfg)


def create_app(runtime: Optional[Runtime] = None):
    """Build the FastAPI app. Pass a started Runtime to inject one (tests);
    otherwise one is built from the environment and loads in the background."""
    if runtime is None:
        runtime = build_runtime()
        runtime.start(background=True)
    runtime_app = create_runtime_app(runtime)

    # The runtime answers the contract itself; the studio's loose /api/evaluate
    # proxies to it over the ASGI boundary (no HTTP hop, no duplicated parsing).
    proxy = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app), base_url="http://runtime"
    )

    @asynccontextmanager
    async def lifespan(api: FastAPI):
        try:
            yield
        finally:
            await proxy.aclose()
            runtime.stop()

    api = FastAPI(
        title="d3 Studio",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    api.state.runtime = runtime

    # /api/docs shows everything: FastAPI's own schema plus the mounted
    # runtime's hand-written contract. The runtime app is a plain Starlette
    # router mounted at "/", invisible to FastAPI's schema generator — without
    # this merge the Swagger UI lists only the studio's /api/* routes and
    # hides /v1/systemone and friends even though they answer requests.
    studio_openapi = api.openapi

    def openapi() -> dict[str, Any]:
        schema = studio_openapi()
        try:
            contract = yaml.safe_load(RUNTIME_OPENAPI_PATH.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            _log.warning("the runtime contract is unreadable; /api/docs lists the studio routes only")
            return schema
        paths = contract.get("paths") or {}
        schemas = (contract.get("components") or {}).get("schemas") or {}
        schema.setdefault("paths", {}).update(paths)
        if schemas:
            schema.setdefault("components", {}).setdefault("schemas", {}).update(schemas)
        for path_item in paths.values():
            for op in path_item.values():
                if isinstance(op, dict):
                    op.setdefault("tags", ["runtime contract"])
        return schema

    api.openapi = openapi

    def served_model() -> dict[str, Any]:
        served = next(iter(runtime.served), None)
        return {
            "served_name": served.config.name if served else None,
            "model": served.config.model if served else None,
            "device": served.config.device if served else None,
            **model_spec(),
        }

    @api.get("/api/status")
    def status() -> dict[str, Any]:
        return {
            "status": "ok",
            "backend": "vllm-srun",
            "runtime": {
                "state": runtime.health.state,
                "reason": runtime.health.reason,
                "ready": runtime.health.ready,
            },
            "model": served_model(),
            "limits": public_limits(),
        }

    @api.get("/api/ready")
    def ready():
        """503 until the runtime's model is loaded, verified and warm, so the
        studio can show the offline note while the weights arrive."""
        state = runtime.health.state
        return JSONResponse(
            {
                "backend": "vllm-srun",
                "status": "ready" if runtime.health.ready else state,
                "reason": runtime.health.reason,
                "model": served_model(),
            },
            status_code=200 if runtime.health.ready else 503,
        )

    @api.get("/api/examples")
    def examples():
        return load_decks()

    @api.post("/api/evaluate")
    async def evaluate(request: Request):
        """Loose internal endpoint: everything goes to the runtime's
        /v1/systemone, which answers multi-question and multi-state requests
        in one call."""
        content_type = request.headers.get("content-type", "application/json")
        body = await request.body()
        try:
            response = await proxy.post(
                "/v1/systemone",
                content=body,
                headers={"content-type": content_type},
                timeout=public_limits()["synchronous_wait_seconds"],
            )
        except httpx.HTTPError:
            _log.exception("runtime proxy failed")
            raise HTTPException(502, "the runtime is unreachable") from None
        if response.status_code < 400 or not response.content:
            return Response(
                content=response.content,
                status_code=response.status_code,
                media_type=response.headers.get("content-type", "application/json"),
            )
        # Runtime errors (4xx contract, 5xx) pass through as the runtime said them.
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type", "application/json"),
        )

    @api.middleware("http")
    async def response_headers(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        path = request.url.path
        if path.startswith("/api/") or path.startswith("/v1/") or path in ("/metrics", "/health"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Process-Time-Ms"] = f"{(time.perf_counter() - started) * 1000.0:.2f}"
        return response

    # The studio UI: index at /, everything else under /assets. Deck media
    # (the CC-licensed samples the vision and video decks ship) at /media.
    api.mount("/assets", StaticFiles(directory=ROOT / "static"), name="assets")
    api.mount("/media", StaticFiles(directory=ROOT / "media"), name="media")

    @api.get("/")
    async def index():
        index_html = ROOT / "static" / "index.html"
        if not index_html.is_file():
            raise HTTPException(503, "the studio UI is not built yet")
        return FileResponse(index_html, media_type="text/html")

    # The runtime contract: /v1/*, /health, /health/live, /metrics. Mounted
    # last — everything the studio did not claim falls through to it.
    api.mount("/", runtime_app, name="runtime")
    return api


def main() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="d3 Studio")
    parser.add_argument("--host", default=os.environ.get("D3_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("D3_PORT", "7860") or 7860))
    parser.add_argument("--model", default=None,
                        help=f"hub model to serve (default {DEFAULT_MODEL})")
    parser.add_argument("--revision", default=None, help="40-hex revision to pin")
    parser.add_argument("--model-dir", default=None,
                        help="serve a local package directory instead (the tiny turbo fixture)")
    parser.add_argument("--device", default=None, help="auto | cuda | cpu")
    args = parser.parse_args()
    if args.model:
        os.environ["D3_MODEL"] = args.model
    if args.revision:
        os.environ["D3_REVISION"] = args.revision
    if args.model_dir:
        os.environ["D3_MODEL_DIR"] = args.model_dir
    if args.device:
        os.environ["D3_DEVICE"] = args.device
    uvicorn.run(
        create_app(), host=args.host, port=args.port,
        log_level=os.environ.get("D3_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
