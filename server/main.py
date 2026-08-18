"""FastAPI app: upload, job status, stem streaming, SPA hosting."""
import logging
import subprocess
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from jobs import JobManager
from pipeline import DATA_DIR, JOBS_DIR, run_job

logging.basicConfig(level=logging.INFO)

UPLOADS_DIR = DATA_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".ogg", ".m4a"}
MAX_UPLOAD = 100 * 1024 * 1024  # 100MB

app = FastAPI(title="stem splitter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",  # vite dev
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

manager = JobManager(lambda job: run_job(job, _update(job.id)))


def _update(job_id):
    return lambda **fields: manager.update(job_id, **fields)


@app.post("/api/jobs")
async def create_job(tier: str = "fast", file: UploadFile = File(...)):
    if tier not in ("fast", "studio"):
        raise HTTPException(400, "tier must be fast or studio")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"unsupported file type {ext}; allowed: {sorted(ALLOWED_EXT)}")

    dest = UPLOADS_DIR / f"{uuid.uuid4().hex[:12]}{ext}"
    size = 0
    with dest.open("wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close()
                dest.unlink()
                raise HTTPException(400, "file too large (max 100MB)")
            f.write(chunk)

    # sanity: must be decodable audio
    r = subprocess.run(
        ["ffprobe", "-v", "error", str(dest)], capture_output=True)
    if r.returncode != 0:
        dest.unlink()
        raise HTTPException(400, "file is not valid audio")

    job = manager.submit(file.filename, tier, str(dest))
    return {"id": job.id}


@app.get("/api/jobs")
def list_jobs():
    return manager.list()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job.public()


@app.get("/api/jobs/{job_id}/stems/{stem_file}")
def get_stem(job_id: str, stem_file: str):
    job = manager.get(job_id)
    if not job or not any(s["file"] == stem_file for s in job.stems):
        raise HTTPException(404)
    path = JOBS_DIR / job_id / stem_file
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/flac", filename=stem_file)


# SPA: serve built frontend when it exists (dev uses Vite proxy instead)
DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="spa")

    from starlette.exceptions import HTTPException as SHTTPException

    @app.exception_handler(SHTTPException)
    async def spa_fallback(request, exc):
        # deep links like /job/<id> don't exist on disk; serve the app shell
        if not request.url.path.startswith("/api") and exc.status_code == 404:
            return FileResponse(DIST / "index.html")
        raise exc
