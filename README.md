# Stem Splitter

Local web app for splitting songs into instrument stems, built around the
guitar-transcription workflow: isolate the guitar, slow it down, loop a riff, learn it.

## What it does

- Upload a song (mp3/wav/flac/ogg/m4a) through the web UI
- **Fast tier**: Demucs `htdemucs_6s` → vocals, drums, bass, guitar, piano, other (~8x realtime on CPU)
- **Studio tier**: BS-RoFormer vocal removal → Demucs guitar extraction (5-shift averaging) → guitar + no-guitar (~3x realtime on CPU)
- Multi-stem mixer: per-stem volume/mute/solo, pitch-preserved speed control (0.5–1.25x),
  draggable loop regions, zoomable waveforms (wheel zoom, up to 200x), per-stem download

## Layout

- `server/` — FastAPI backend: upload API, job queue (single worker thread), separation pipelines
- `web/` — React (Vite) SPA: upload page, job progress, stem mixer
- `demucs-run`, `audio-separator-run`, `guitar-split` — CLI wrappers for the same pipelines

## Setup

```sh
# Python env (uv) — needs demucs, audio-separator[cpu], fastapi, uvicorn, soundfile
uv venv --python 3.12 .venv-demucs
uv pip install --python .venv-demucs/bin/python demucs "audio-separator[cpu]" \
    fastapi uvicorn python-multipart soundfile audioread "librosa<1.0" --upgrade beartype

# Frontend
cd web && npm install && npm run build && cd ..

# Run (serves UI + API on http://localhost:8000)
./server/run.sh
```

Notes:
- `demucs-run` / `audio-separator-run` / `server/run.sh` set `PYTHONPATH` directly because
  CPython venv detection is broken inside the ZCode appimage sandbox; harmless in a normal terminal.
- Separation model weights download automatically on first use (~300MB Demucs, ~640MB RoFormer).
- Jobs are in-memory: restarting the server clears the list (stems stay on disk in `data/jobs/`).
- CPU-only (no CUDA). RoFormer stage is ~3x realtime; expect minutes per song on the Studio tier.
