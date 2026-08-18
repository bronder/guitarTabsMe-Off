"""In-memory job manager: queue + single worker thread (separation is CPU-bound)."""
import queue
import threading
import time
import uuid


class Job:
    def __init__(self, job_id, name, tier, upload_path):
        self.id = job_id
        self.name = name
        self.tier = tier  # "fast" | "studio"
        self.upload_path = upload_path
        self.state = "queued"  # queued|stage1|stage2|done|error
        self.progress = 0.0  # 0..100 across the whole job
        self.stage_detail = ""
        self.error = None
        self.created_at = time.time()
        self.finished_at = None
        self.stems = []  # [{"name": "guitar", "file": "guitar.flac", "bytes": N}]
        self.duration = None

    def public(self):
        return {
            "id": self.id,
            "name": self.name,
            "tier": self.tier,
            "state": self.state,
            "progress": round(self.progress, 1),
            "stage_detail": self.stage_detail,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "duration": self.duration,
            "stems": self.stems,
        }


class JobManager:
    def __init__(self, runner):
        self._jobs = {}
        self._order = []
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        self._runner = runner  # callable(job) -> None, raises on failure
        self._worker = threading.Thread(target=self._work, daemon=True, name="separation-worker")
        self._worker.start()

    def submit(self, name, tier, upload_path):
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, name, tier, upload_path)
        with self._lock:
            self._jobs[job_id] = job
            self._order.append(job_id)
        self._queue.put(job_id)
        return job

    def get(self, job_id):
        return self._jobs.get(job_id)

    def list(self):
        with self._lock:
            return [self._jobs[j].public() for j in reversed(self._order)]

    def update(self, job_id, **fields):
        with self._lock:
            job = self._jobs[job_id]
            for k, v in fields.items():
                setattr(job, k, v)

    def _work(self):
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            try:
                self._runner(job)
                self.update(job_id, state="done", progress=100.0, finished_at=time.time())
            except Exception as e:  # noqa: BLE001 - surface any pipeline failure to the UI
                self.update(job_id, state="error", error=str(e), finished_at=time.time())
