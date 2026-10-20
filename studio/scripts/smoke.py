"""Post-deploy smoke test — run against the deployed studio's URL.

Checks the readiness lifecycle and every answer surface the studio UI uses:
1-question text (choice + noul), a Box on an uploaded image, a Track on an
uploaded clip, and the multi-question state-once read. Exits 0 only when
everything passes, so it gates the deploy report.

    .venv/bin/python studio/scripts/smoke.py https://d3-studio-user-mhepburn.apps.cluster.com
"""
from __future__ import annotations

import base64
import io
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7860").rstrip("/")


def get(path: str, timeout: int = 30):
    with urlopen(f"{BASE}{path}", timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def post(path: str, body: dict, timeout: int = 120):
    req = Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def image_data_url(name: str) -> str:
    raw = (ROOT / "media" / name).read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


def video_data_url(name: str) -> str:
    raw = (ROOT / "media" / name).read_bytes()
    return "data:video/webm;base64," + base64.b64encode(raw).decode()


def wait_ready(deadline_seconds: int = 1200) -> None:
    """Wait for /api/ready 200 — covers the init pull (~2-10 min) plus the
    model load (~1-3 min from the page cache)."""
    print(f"waiting for {BASE}/api/ready (deadline {deadline_seconds}s)…")
    t0 = time.time()
    while time.time() - t0 < deadline_seconds:
        try:
            status, body = get("/api/ready")
            if status == 200 and body.get("status") == "ready":
                print(f"  ready after {time.time() - t0:.0f}s")
                return
            print(f"  {status}: {body.get('status')} ({time.time() - t0:.0f}s)")
        except Exception as exc:  # noqa: BLE001 — any error means not ready yet
            print(f"  {exc} ({time.time() - t0:.0f}s)")
        time.sleep(10)
    raise SystemExit("FAIL: the studio never became ready")


def check(name: str, condition: bool, detail: str = "") -> None:
    mark = "PASS" if condition else "FAIL"
    print(f"{mark}: {name}" + (f" — {detail}" if detail else ""))
    if not condition:
        raise SystemExit(f"FAIL: {name}")


def main() -> int:
    wait_ready()

    status, body = get("/api/status")
    check("api/status", status == 200 and body.get("backend") == "vllm-srun")
    model = body.get("model", {})
    print(f"  served: {model.get('served_name')} device={model.get('device')} source={model.get('source')}")

    status, body = get("/api/examples")
    check("api/examples decks", status == 200 and len(body.get("decks", [])) >= 5,
          f"{len(body.get('decks', []))} decks")

    # 1-question text: choice + noul in one call (state once)
    status, body = post("/v1/systemone", {
        "state": "Ticket: the invoice total is wrong after the plan change.",
        "questions": {
            "route": {"type": "choice", "instructions": "Which team?",
                      "criteria": {"billing": "Billing", "tech": "Technical support"}},
            "urgent": {"type": "noul", "instructions": "Is the customer asking for an urgent fix?"},
        },
    })
    answers = body.get("answers", {})
    check("systemone text", status == 200 and "route" in answers and "urgent" in answers,
          f"route={answers.get('route', {}).get('choice')}")
    probs = answers.get("route", {}).get("probabilities", {})
    check("choice probabilities", abs(sum(probs.values()) - 1.0) < 1e-6)
    check("noul probability", 0.0 <= answers.get("urgent", {}).get("noul", -1) <= 1.0)

    # state-once: 16 questions, one read
    status, body = post("/v1/systemone", {
        "state": "One state.",
        "questions": {f"q{i}": {"type": "noul", "instructions": f"Question {i}?"} for i in range(16)},
    })
    check("state-once 16 questions", status == 200 and len(body.get("answers", {})) == 16)

    # Box on a sample image, paired with a yes / no
    status, body = post("/v1/systemone", {
        "state": "A photo from a dog festival.",
        "images": [image_data_url("frisbee.jpg")],
        "questions": {
            "frisbee": {"type": "box", "instructions": "The frisbee"},
            "present": {"type": "noul", "instructions": "Is a frisbee visible?"},
        },
    }, timeout=300)
    box = body.get("answers", {}).get("frisbee", {})
    check("box", status == 200 and box.get("type") == "box"
          and all(0.0 <= box.get("box", {}).get(e, -1) <= 1.0 for e in ("top", "bottom", "left", "right")))

    # Track on the sample clip
    status, body = post("/v1/systemone", {
        "state": "A bird at a feeder.",
        "videos": [video_data_url("hummingbird.webm")],
        "questions": {"target": {"type": "track", "instructions": "The hummingbird", "rate": 2}},
    }, timeout=600)
    track = body.get("answers", {}).get("target", {}).get("track", [])
    check("track", status == 200 and len(track) >= 8, f"{len(track)} points")

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
