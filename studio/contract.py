"""Studio-side contract helpers.

The heavy lifting — request parsing, question validation, image/video decoding,
limits and queue bounds — is the embedded runtime's own (``vllm_srun``); the
studio only reports the contract to the UI and sanity-checks the decks it
serves. Everything here fails closed: a deck that cannot be trusted is not
served.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parent

# The studio's public limits, reported to the UI and enforced by the runtime:
# the free API's own values, below the model's own (255 questions, 131k tokens).
# Image and video limits follow the runtime's wire contract (data URLs).
LIMITS = {
    "questions": 64,
    "states": 64,
    "request_chars": 131_072,
    "images": 16,
    "image_max_bytes": 16 << 20,
    "videos": 1,
    "video_max_seconds": 60,
    "synchronous_wait_seconds": 120,
}

# Question types the UI may author. choice / noul / score are the System One
# basics; box and track are d3-turbo's own (its card declares them).
QUESTION_TYPES = frozenset({"choice", "noul", "score", "box", "track"})

# Deck modes map to UI surfaces.
DECK_MODES = frozenset({"text", "vision", "video"})


def load_decks() -> dict[str, Any]:
    """The curated deck catalog, sanity-checked. A broken catalog fails closed
    (500 with a plain message) instead of serving a UI that cannot trust it."""
    path = ROOT / "examples.json"
    try:
        decks = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "the deck catalog is unreadable") from exc
    _validate_decks(decks)
    return decks


def _validate_decks(decks: Any) -> None:
    if not isinstance(decks, dict) or not isinstance(decks.get("decks"), list):
        raise HTTPException(500, "the deck catalog has no decks list")
    seen: set[str] = set()
    for deck in decks["decks"]:
        if not isinstance(deck, dict):
            raise HTTPException(500, "a deck is not an object")
        deck_id = deck.get("id")
        if not isinstance(deck_id, str) or not deck_id:
            raise HTTPException(500, "a deck has no id")
        if deck_id in seen:
            raise HTTPException(500, f"duplicate deck id: {deck_id}")
        seen.add(deck_id)
        if deck.get("mode") not in DECK_MODES:
            raise HTTPException(500, f"deck {deck_id}: unknown mode")
        questions = deck.get("questions")
        if not isinstance(questions, dict) or not questions:
            raise HTTPException(500, f"deck {deck_id}: no questions")
        if len(questions) > LIMITS["questions"]:
            raise HTTPException(500, f"deck {deck_id}: too many questions")
        for name, question in questions.items():
            if not isinstance(question, dict):
                raise HTTPException(500, f"deck {deck_id}: question {name} is not an object")
            if question.get("type") not in QUESTION_TYPES:
                raise HTTPException(500, f"deck {deck_id}: question {name} has an unknown type")
        if deck.get("mode") == "vision":
            _validate_media_deck(deck, deck_id, "images")
        if deck.get("mode") == "video":
            _validate_media_deck(deck, deck_id, "videos")
        # Asset references carry image files too (images inside the state, a
        # question's instructions or its options); each must be credited
        # and present.
        assets = deck.get("assets")
        if assets is not None:
            if not isinstance(assets, dict):
                raise HTTPException(500, f"deck {deck_id}: assets must be an object")
            for ref, entry in assets.items():
                if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
                    raise HTTPException(500, f"deck {deck_id}: asset {ref} has no file")
                _credited(deck_id, entry["file"])
        # Recorded replays are optional; when present they must be one per deck.
        replays = deck.get("replays")
        if replays is not None and not isinstance(replays, dict):
            raise HTTPException(500, f"deck {deck_id}: replays must be an object")


def _credited(deck_id: str, file: str) -> None:
    """Every media sample must be credited (CC BY-SA needs its attribution)."""
    credits = load_credits()
    if file not in credits:
        raise HTTPException(500, f"deck {deck_id}: media/{file} has no credits entry")
    media = ROOT / "media" / file
    if not media.is_file():
        raise HTTPException(500, f"deck {deck_id}: missing media/{file}")


def load_credits() -> dict[str, Any]:
    """The per-file attribution map. Unreadable credits fail closed."""
    try:
        doc = json.loads((ROOT / "examples.json").read_text(encoding="utf-8"))
        credits = doc.get("credits")
        return credits if isinstance(credits, dict) else {}
    except (OSError, ValueError):
        raise HTTPException(500, "the deck catalog is unreadable") from None


def _validate_media_deck(deck: dict[str, Any], deck_id: str, field: str) -> None:
    """A vision deck ships its sample images, a video deck its clip, under
    ``media/``; the deck names them. A vision deck may instead (or also) carry
    its images as asset references. Fail closed when a sample is missing."""
    assets = deck.get("assets") or {}
    has_assets = isinstance(assets, dict) and len(assets) > 0
    if field == "videos":
        samples = deck.get(field)
        if not isinstance(samples, list) or not samples:
            raise HTTPException(500, f"deck {deck_id}: {field} list missing")
    else:
        samples = deck.get(field) or []
        if not samples and not has_assets:
            raise HTTPException(500, f"deck {deck_id}: no images and no assets")
    if len(samples) > LIMITS.get(field, 16):
        raise HTTPException(500, f"deck {deck_id}: too many {field}")
    for sample in samples:
        if not isinstance(sample, dict) or not isinstance(sample.get("file"), str):
            raise HTTPException(500, f"deck {deck_id}: {field} sample has no file")
        _credited(deck_id, sample["file"])


def public_limits() -> dict[str, Any]:
    """The limits the UI displays (and the runtime enforces)."""
    return dict(LIMITS)
