Run from a committed checkout on a Linux x86_64 Docker runner with at least four available CPUs and 8 GiB for the test container. The image build downloads the locked dependencies. The test container has no external network or host environment files; its HTTP/TLS fixtures use loopback only.

```bash
set -euo pipefail
NARRIFLOW_MEDIA_CONTEXT="$(mktemp -d)"
trap 'rm -rf -- "$NARRIFLOW_MEDIA_CONTEXT"' EXIT

git archive HEAD | tar -x -C "$NARRIFLOW_MEDIA_CONTEXT"
cp "$NARRIFLOW_MEDIA_CONTEXT/apps/media/images/render.dockerignore" \
  "$NARRIFLOW_MEDIA_CONTEXT/.dockerignore"

docker build --platform linux/amd64 \
  --file "$NARRIFLOW_MEDIA_CONTEXT/apps/media/images/Dockerfile" \
  --build-arg MEDIA_PROFILE=render --build-arg MEDIA_THREADS=4 \
  --tag narriflow-media:native-ci "$NARRIFLOW_MEDIA_CONTEXT"

NARRIFLOW_MEDIA_CPUSET="$(python3 -c \
  'import os; cpus=sorted(os.sched_getaffinity(0)); assert len(cpus)>=4; print(",".join(map(str,cpus[:4])))')"
docker run --rm --init --platform linux/amd64 \
  --network none --cpus 4 --cpuset-cpus "$NARRIFLOW_MEDIA_CPUSET" \
  --memory 8g --memory-swap 8g --workdir /app \
  --env PYTHONPATH=/app/apps/media/python:/app \
  narriflow-media:native-ci \
  python -m unittest discover -s apps/media/python/tests -p 'test_*.py'
```

The [recorded final Linux sweep](../../../../.scratch/serverless-cutover/evidence/final-linux-native-parity-20261101.json) passes 162 tests under Bun 1.3.6 and Python 3.13.5, including actual native children for rendering, preparation, source/audio, token helper, asset/image validation, publication, dubbing and export bundles. Domain/control/storage/provider replies are controlled fixtures. This command does not establish live Worker/PostgreSQL fences or R2 behavior.

For an existing image built from the same committed checkout, use only the `docker run` step. Do not pass database/provider variables, mount local environment files, or give this test container external network access. Image validation and full golden provenance are recorded in `.scratch/serverless-cutover/evidence/render-thread-policy-20261031.json`; its exact36-case reference comparison is a separate gate.
