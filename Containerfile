# Single stage on the s2i image: pip's configured target is /opt/app-root, so
# no cross-stage copies of site-packages. Layers are ordered for caching: a
# studio code edit rebuilds from the COPY below without re-downloading the
# ~3 GB of wheels.
FROM registry.access.redhat.com/ubi9/python-312:latest
# gcc + python3.12-devel are required at runtime: Triton JIT-compiles its CUDA
# driver stub with a C compiler on the first GPU kernel launch, and that stub
# includes <Python.h> (the laya-studio gotcha). libgomp: torch.
USER 0
RUN dnf install -y gcc python3.12-devel libgomp \
    && dnf clean all \
    && rm -rf /var/cache/dnf
# Dependencies first, in two layers: torch (rarely changes, ~3 GB of wheels)
# then the studio deps (change more often, re-install from the cache).
COPY model-runtime /tmp/build/model-runtime
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir \
        /tmp/build/model-runtime[multimodal] \
        fastapi \
        httpx \
        flash-linear-attention \
    && rm -rf /tmp/build
# Application sources last: a code edit rebuilds from here on only.
COPY studio /opt/app-root/src/studio
RUN /usr/bin/fix-permissions /opt/app-root/src
USER 1001
WORKDIR /opt/app-root/src
# The app's configuration comes from the environment (the Helm chart pins the
# model, device and offline flag); D3_OFFLINE stays 0 here so the image also
# works standalone with its own HF cache. The init container sets HF_HOME to
# the shared volume; the chart's env does the same for the app container.
ENV PYTHONUNBUFFERED=1 \
    HF_HOME=/weights \
    D3_HOST=0.0.0.0 \
    D3_PORT=8080 \
    D3_MODEL=vllm-sr/d3-turbo \
    D3_DEVICE=cuda
EXPOSE 8080
CMD ["python", "-m", "studio.app"]
