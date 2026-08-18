#!/bin/sh
# Launch the stem splitter web server on http://localhost:8000
# Same PYTHONPATH workaround as demucs-run (ZCode sandbox breaks venv detection;
# harmless when run from a normal terminal).
BASE="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$BASE/.venv-demucs/lib/python3.14/site-packages${PYTHONPATH:+:$PYTHONPATH}"
cd "$BASE/server" || exit 1
exec "$BASE/.venv-demucs/bin/python" -m uvicorn main:app --host 0.0.0.0 --port 8000
