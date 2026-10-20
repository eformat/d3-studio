"""Idempotent pinned-revision pull — the deployment's init container runs this.

Downloads the d3-turbo weights from the Hub into ``HF_HOME`` (the shared PVC
mount), then writes a marker file next to them. The marker lives on the shared
volume, so restarts and sibling pods skip the ~52 GiB pull. The runtime
re-verifies every file digest against the pinned manifest at load, so the
pull's integrity is checked again by the app.

Environment: ``D3_MODEL`` (default vllm-sr/d3-turbo), ``D3_REVISION`` (default
the pinned Decision 3.0 release), ``HF_HOME`` (the shared volume), optional
``HF_TOKEN`` (faster, authenticated pull — supplied by a Secret reference,
never baked into an image).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = os.environ.get("D3_MODEL", "vllm-sr/d3-turbo").strip() or "vllm-sr/d3-turbo"
REVISION = os.environ.get("D3_REVISION", "").strip() or "689b3af198baaf6f11110be38a9daa7188dfd8ad"


def main() -> int:
    from huggingface_hub import snapshot_download

    cache = Path(os.environ.get("HF_HOME", ".")).expanduser()
    marker = cache / f".pulled-{REVISION}"
    if marker.is_file():
        print(f"weights for {REPO}@{REVISION[:12]} already present; skipping")
        return 0
    token = os.environ.get("HF_TOKEN") or None
    path = snapshot_download(repo_id=REPO, revision=REVISION, token=token)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("ok\n")
    print(f"pulled {REPO}@{REVISION[:12]} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
