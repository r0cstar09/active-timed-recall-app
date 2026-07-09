# Spanish Active Timed Recall App

## Access / scope

When using Claude Code/Fable for this project, treat the Spanish frontend and backend as one system. Grant broad project read/write access with `--add-dir` to:

```text
/home/rootadmin/active-timed-recall-app
/home/rootadmin/hermes-spanish/shadowing
/home/rootadmin/Spanish-daily-verb-project
/home/rootadmin/hermes-ha
```

This project is allowed to inspect deployment scripts, systemd unit shapes, Caddy config, and HA reports needed to fix production Spanish app issues. Do not dump raw secrets into prompts/logs; use local credential files directly and report only metadata/paths.

## Production routing invariants

- Public frontend: `https://spanish-app.tonymuzo.dev`
- Public API: `https://api-spanish.tonymuzo.dev`
- The frontend must call only `https://api-spanish.tonymuzo.dev` for public production API traffic.
- Retired/split-brain target: `https://tonys-alienware-1.tail85fe36.ts.net` must not be used as an active API base.

## Timer invariant

Every timed recall mode is fixed at 15 seconds:

```text
review
practice
misses
cloze
english_to_spanish
audio_shadow
```

Do not make the client timer adaptive or env-dependent. The frontend should ignore legacy backend per-item timer values and return the fixed constants.

## Required verification before reporting success

```bash
npm ci
npm run build
python3 - <<'PY'
from pathlib import Path
cfg = Path('src/lib/config.ts').read_text()
rec = Path('src/components/RecallSession.tsx').read_text()
docker = Path('Dockerfile.cloudrun').read_text()
dist = ''.join(p.read_text(errors='ignore') for p in Path('dist/_astro').glob('*.js'))
assert 'https://api-spanish.tonymuzo.dev' in cfg
assert 'export const RECALL_SECONDS = 15;' in cfg
assert 'export const MAX_RECALL_SECONDS = 15;' in cfg
assert 'return Math.min(RECALL_SECONDS, MAX_RECALL_SECONDS);' in rec
assert 'https://api-spanish.tonymuzo.dev' in docker
assert 'https://api-spanish.tonymuzo.dev' in dist
print('frontend contract ok')
PY
```

For backend-coupled changes, also run:

```bash
cd /home/rootadmin/hermes-spanish/shadowing
/home/rootadmin/.venvs/spanish/bin/python -m py_compile api.py sprint.py config.py worker.py llm.py
/home/rootadmin/.venvs/spanish/bin/python -m pytest -q tests/test_web_backend.py tests/test_recall_hardening.py
```

## Deployment

Cloud Run service:

```text
project: hermes-ai-agent-497702
region: us-east1
service: spanish-app
image repo: us-east1-docker.pkg.dev/hermes-ai-agent-497702/tonymuzo-apps/app
```

The repo owns `.github/workflows/deploy-spanish-app.yml`; it requires repo secret `GCP_SA_KEY` containing a deploy-capable service-account JSON. The HA lease service account is not enough for deploys.
