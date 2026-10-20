# d3 Studio
#
# make fixture   build the tiny random-weight turbo package into .fixture/turbo
# make serve     run the studio at http://127.0.0.1:$(PORT) against the fixture
#                (default target; D3_MODEL_DIR set, no downloads)
# make serve-real  run the studio against the real d3-turbo (a ~52 GiB HF cache
#                or the container's baked weights — not this laptop)
# make install   install requirements into .venv (creates it if missing)
# make test      run the API tests against the tiny turbo package
# make clean     remove test/build caches
# make image     build the Quay image (deps only — weights are pulled by the
#                init container on the cluster, not baked)
# make push      push the image to Quay
# make smoke     run the post-deploy smoke test against a URL (make smoke URL=…)

VENV   := .venv
PYTHON := $(VENV)/bin/python

# Run configuration: make serve PORT=8000 HOST=0.0.0.0
HOST  ?= 127.0.0.1
PORT  ?= 7860

# Image configuration: make image NAMESPACE=eformat TAG=latest
NAMESPACE ?= eformat
IMAGE     ?= quay.io/$(NAMESPACE)/d3-studio
TAG       ?= latest
# The vllm-srun runtime's checkout (synced into the build context by make image)
SEMANTIC_ROUTER ?= $(HOME)/git/semantic-router

# The tiny turbo package (d3-turbo's card, random weights, ~1 MiB): local
# development and tests run against it, no 52 GiB download.
FIXTURE := .fixture/turbo

.PHONY: serve serve-real install test fixture clean image push smoke

serve: $(PYTHON) $(FIXTURE)
	D3_MODEL_DIR=$(CURDIR)/$(FIXTURE) D3_DEVICE=cpu \
		$(PYTHON) -m studio.app --host $(HOST) --port $(PORT)

serve-real: $(PYTHON)
	$(PYTHON) -m studio.app --host $(HOST) --port $(PORT)

$(PYTHON):
	python3.12 -m venv $(VENV)
	$(PYTHON) -m pip install torch --index-url https://download.pytorch.org/whl/cpu
	$(PYTHON) -m pip install ./model-runtime[multimodal] fastapi

$(FIXTURE): $(PYTHON)
	@mkdir -p .fixture
	$(PYTHON) -c "from vllm_srun.testing.decision3 import write_fixture; write_fixture('$(FIXTURE)', 'turbo', 0)"

install: $(PYTHON)
	$(PYTHON) -m pip install torch --index-url https://download.pytorch.org/whl/cpu
	$(PYTHON) -m pip install ./model-runtime[multimodal] fastapi

test: $(PYTHON) $(FIXTURE)
	D3_MODEL_DIR=$(CURDIR)/$(FIXTURE) $(PYTHON) -m pytest studio/tests/ -q

clean:
	rm -rf .pytest_cache .fixture
	find studio -name __pycache__ -type d -prune -exec rm -rf {} +

image:
	rsync -a --delete $(SEMANTIC_ROUTER)/src/model-runtime/ ./model-runtime/
	podman build -t $(IMAGE):$(TAG) .

push: image
	podman push $(IMAGE):$(TAG)

# Post-deploy smoke test: make smoke URL=https://d3-studio-user-mhepburn.apps.ocp.cloud.rhai-tmm.dev
smoke: $(PYTHON)
	$(PYTHON) studio/scripts/smoke.py $(URL)
