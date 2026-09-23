#!/usr/bin/env bash
# Run on the existing GPU machine. No GPU provisioning or OpenAI calls.
set -euo pipefail
umask 077
runtime_dir="${CQ_RUNTIME_DIR:-$HOME/career-quest-ai}"
mkdir -p "$runtime_dir/cache"
cd "$runtime_dir"
if docker container inspect career-quest-llm >/dev/null 2>&1; then
  if [ ! -f runtime.env ]; then
    echo 'Existing container has no runtime.env; restore its credential before reconnecting.' >&2
    exit 1
  fi
  echo 'career-quest-llm already exists; inspect it before explicitly replacing it.'
  exit 0
fi
if [ ! -f runtime.env ]; then
  python3 - <<'PY'
import os, secrets
with open('runtime.env', 'x') as f:
    f.write('VLLM_API_KEY=' + secrets.token_urlsafe(48) + '\n')
os.chmod('runtime.env', 0o600)
PY
fi
image='vllm/vllm-openai:v0.30.0@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90'
model='Qwen/Qwen3-4B-Instruct-2507'
revision='cdbee75f17c01a7cc42f958dc650907174af0554'
docker pull "$image"
docker run -d --name career-quest-llm --restart unless-stopped \
  --gpus all --shm-size 2g \
  --log-opt max-size=10m --log-opt max-file=3 \
  --env-file runtime.env \
  -e VLLM_NO_USAGE_STATS=1 -e HF_HUB_DISABLE_TELEMETRY=1 \
  -e OMP_NUM_THREADS=2 \
  -v "$runtime_dir/cache:/root/.cache/huggingface" \
  -p 127.0.0.1:8000:8000 \
  "$image" --model "$model" --revision "$revision" \
  --served-model-name "$model" --dtype half \
  --max-model-len 8192 --max-num-seqs 2 --max-num-batched-tokens 2048 \
  --enable-chunked-prefill --safetensors-load-strategy lazy \
  --gpu-memory-utilization 0.80 --enforce-eager \
  --generation-config vllm --no-enable-log-requests \
  --disable-uvicorn-access-log --disable-fastapi-docs
echo 'Model is starting. Check docker logs career-quest-llm and GET /health.'
