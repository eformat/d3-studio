"""The d3-studio API, tested end-to-end against the tiny random-weight turbo
package (``vllm_srun.testing.decision3``, the ``turbo`` variant: d3-turbo's
card — ``prefix_bidir``, Box and Track, images in state, instructions and
criteria) on CPU. Random weights give garbage probabilities, but the contract,
the limits and the studio plumbing are real: the same requests, the same
shapes, the same fail-closed paths the released model serves.
"""
from __future__ import annotations

import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from vllm_srun.config import ModelConfig, ServeConfig
from vllm_srun.runtime import Runtime
from vllm_srun.testing.decision3 import write_fixture

from studio.app import create_app


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    """The studio app with the tiny turbo package served on the CPU."""
    pkg = write_fixture(tmp_path_factory.mktemp("turbo-fixture") / "turbo", "turbo", 0)
    cfg = ServeConfig(
        models=(ModelConfig(model=str(pkg), device="cpu", name="d3-turbo"),),
        offline=True,
        threads=2,
    )
    runtime = Runtime(cfg)
    runtime.start(background=True)
    if not runtime.wait(timeout=120):
        raise RuntimeError("the tiny fixture never became ready")
    # The app's lifespan stops the runtime when the client closes.
    with TestClient(create_app(runtime)) as c:
        yield c


def red_square_data_url(width: int = 64, height: int = 64) -> str:
    img = Image.new("RGB", (width, height), (200, 30, 30))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


TICKET = {
    "state": "Ticket: the invoice total is wrong after the plan change.",
    "questions": {
        "route": {
            "type": "choice",
            "instructions": "Which team?",
            "criteria": {"billing": "Billing", "tech": "Technical support"},
        },
        "urgent": {"type": "noul", "instructions": "Is the customer asking for an urgent fix?"},
    },
}


class TestStudio:
    def test_ready(self, client):
        r = client.get("/api/ready")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ready"
        assert body["backend"] == "vllm-srun"

    def test_status(self, client):
        r = client.get("/api/status")
        assert r.status_code == 200
        body = r.json()
        assert body["backend"] == "vllm-srun"
        assert body["runtime"]["state"] == "ready"
        assert body["runtime"]["ready"] is True
        assert body["model"]["served_name"] == "d3-turbo"
        assert body["limits"]["questions"] == 64

    def test_examples(self, client):
        r = client.get("/api/examples")
        assert r.status_code == 200
        decks = r.json()["decks"]
        assert decks
        for deck in decks:
            assert deck["id"]
            assert deck["mode"] in ("text", "vision", "video")
            assert deck["questions"]

    def test_index(self, client):
        r = client.get("/")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]

    def test_health_mounted(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ready"


class TestSystemOne:
    def test_single(self, client):
        r = client.post("/v1/systemone", json=TICKET)
        assert r.status_code == 200
        body = r.json()
        answers = body["answers"]
        assert answers["route"]["type"] == "choice"
        assert set(answers["route"]["probabilities"]) == {"billing", "tech"}
        assert abs(sum(answers["route"]["probabilities"].values()) - 1.0) < 1e-6
        assert 0.0 <= answers["urgent"]["noul"] <= 1.0

    def test_state_once(self, client):
        """One read of the state answers every question: N questions, one call."""
        questions = {f"q{i}": {"type": "noul", "instructions": f"Question {i}?"} for i in range(8)}
        r = client.post("/v1/systemone", json={"state": "One state.", "questions": questions})
        assert r.status_code == 200
        answers = r.json()["answers"]
        assert set(answers) == set(questions)
        for i in range(8):
            assert 0.0 <= answers[f"q{i}"]["noul"] <= 1.0

    def test_box(self, client):
        r = client.post("/v1/systemone", json={
            "state": "A red square.",
            "images": [red_square_data_url()],
            "questions": {"where": {"type": "box", "instructions": "The red area"}},
        })
        assert r.status_code == 200
        box = r.json()["answers"]["where"]
        assert box["type"] == "box"
        for edge in ("top", "bottom", "left", "right"):
            assert 0.0 <= box["box"][edge] <= 1.0
        assert 0.0 <= box["confidence"] <= 1.0

    def test_box_paired_with_noul(self, client):
        """Exactly one box even when the object may be absent: pair Box with a
        yes / no question."""
        r = client.post("/v1/systemone", json={
            "state": "A photo.",
            "images": [red_square_data_url()],
            "questions": {
                "frisbee": {"type": "box", "instructions": "The frisbee"},
                "present": {"type": "noul", "instructions": "Is a frisbee visible?"},
            },
        })
        assert r.status_code == 200
        answers = r.json()["answers"]
        assert answers["frisbee"]["type"] == "box"
        assert 0.0 <= answers["present"]["noul"] <= 1.0

    def test_score(self, client):
        r = client.post("/v1/systemone", json={
            "state": "The invoice total is wrong after the plan change.",
            "questions": {"tone": {"type": "score", "instructions": "How urgent?", "levels": ["low", "medium", "high"]}},
        })
        assert r.status_code == 200
        answer = r.json()["answers"]["tone"]
        assert answer["type"] == "score"
        assert set(answer["probabilities"]) == {"0", "1", "2"}
        assert answer["legend"] == {"0": "low", "1": "medium", "2": "high"}

    def test_assets_in_state(self, client):
        """Images by reference inside the state text (the assets form)."""
        r = client.post("/v1/systemone", json={
            "state": "This picture: <pic>",
            "assets": {"<pic>": {"type": "image", "data_base64": red_square_data_url().split(",", 1)[1]}},
            "questions": {"pick": {"type": "choice", "instructions": "Which color?", "criteria": {"red": "Red", "blue": "Blue"}}},
        })
        assert r.status_code == 200
        assert r.json()["answers"]["pick"]["type"] == "choice"

    def test_states_multi_state(self, client):
        """The states extension: several states, one call (the batch matrix)."""
        r = client.post("/v1/systemone", json={
            "model": "d3-turbo",
            "state": "First ticket about billing.",
            "questions": {"kind": {"type": "choice", "instructions": "Which?", "criteria": {"a": "A", "b": "B"}}},
            "states": {
                "second": {"state": "Second ticket about a crash.", "questions": {"kind": {"type": "noul", "instructions": "Yes?"}}},
            },
        })
        assert r.status_code == 200
        body = r.json()
        assert "second" in body["states"]
        assert body["states"]["second"]["answers"]["kind"]["type"] == "noul"

    def test_evaluate_loose(self, client):
        r = client.post("/api/evaluate", json=TICKET)
        assert r.status_code == 200
        assert r.json()["answers"]["route"]["type"] == "choice"


class TestFailClosed:
    def test_unknown_type(self, client):
        r = client.post("/v1/systemone", json={
            "state": "x", "questions": {"q": {"type": "haiku", "instructions": "write"}}})
        assert r.status_code == 422

    def test_malformed_image(self, client):
        r = client.post("/v1/systemone", json={
            "state": "x", "images": ["data:image/jpeg;base64,not-base64!!"],
            "questions": {"q": {"type": "noul", "instructions": "ok?"}}})
        assert r.status_code == 400
        assert r.json()["error"]["reason"] == "image_malformed"

    def test_broken_deck_fails_closed(self):
        """A catalog with an unknown question type or a missing media sample is
        rejected by the validator (the endpoint serves nothing untrusted)."""
        from studio import contract

        broken = {"decks": [{"id": "x", "mode": "text", "questions": {"q": {"type": "haiku"}}}]}
        with pytest.raises(Exception):
            contract._validate_decks(broken)

        missing_media = {"decks": [{
            "id": "y", "mode": "vision",
            "questions": {"q": {"type": "box", "instructions": "x"}},
            "images": [{"file": "not-there.jpg"}],
        }]}
        with pytest.raises(Exception):
            contract._validate_decks(missing_media)
