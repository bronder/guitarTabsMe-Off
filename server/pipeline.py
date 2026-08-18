"""Separation pipelines: Fast (Demucs 6-stem) and Studio (RoFormer + Demucs guitar)."""
import logging
import subprocess
from pathlib import Path

import soundfile as sf
import torch

log = logging.getLogger("pipeline")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
JOBS_DIR = DATA_DIR / "jobs"

# Stage weighting per tier: how much of total job progress each stage occupies.
STAGE_WEIGHTS = {"fast": {"sep": 1.0}, "studio": {"roformer": 0.75, "demucs": 0.25}}

ROFORMER_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def probe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def write_flac(tensor, dest_path):
    """torch tensor (channels, samples) @44.1k -> FLAC. Returns file size."""
    data = tensor.detach().cpu().numpy().T  # (samples, channels)
    sf.write(str(dest_path), data, 44100, format="FLAC")
    return dest_path.stat().st_size


def run_fast(job, update):
    """Demucs htdemucs_6s, all six stems. ~8x realtime on CPU."""
    from demucs.api import Separator

    out_dir = JOBS_DIR / job.id
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = STAGE_WEIGHTS["fast"]

    def cb(info):
        if info.get("state") != "end":
            return
        frac = ((info["model_idx_in_bag"] + 1) / info["models"]) if info.get("models") else 1.0
        shift = info.get("shift_idx", 0)
        # with shifts>1, shift_idx runs 0..shifts-1; approximate fractional progress
        total_shifts = getattr(cb, "total_shifts", 1)
        progress = ((shift + frac) / total_shifts) * 100 * weights["sep"]
        update(state="stage1", progress=progress,
               stage_detail=f"separating segment @{info['segment_offset'] // 44100}s")

    sep = Separator(model="htdemucs_6s", shifts=1, progress=False, callback=cb)
    cb.total_shifts = 1
    update(state="stage1", progress=0, stage_detail="separating")
    _, stems = sep.separate_audio_file(Path(job.upload_path))

    job.duration = probe_duration(job.upload_path)
    for name, tensor in stems.items():
        size = write_flac(tensor, out_dir / f"{name}.flac")
        job.stems.append({"name": name, "file": f"{name}.flac", "bytes": size})
    update(stage_detail="done")


def run_studio(job, update):
    """Two-stage: BS-RoFormer vocal removal, then Demucs guitar vs rest (5 shifts)."""
    from demucs.api import Separator
    from audio_separator.separator import Separator as ASeparator

    out_dir = JOBS_DIR / job.id
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = STAGE_WEIGHTS["studio"]

    # Stage 1: RoFormer instrumental (no chunk-level progress API; stage-level only)
    update(state="stage1", progress=0, stage_detail="RoFormer vocal removal")
    asep = ASeparator(
        model_file_dir=str(DATA_DIR / "models"),
        output_dir=str(out_dir),
        output_format="FLAC",
        output_single_stem="instrumental",
        log_level=logging.WARNING,
    )
    asep.load_model(model_filename=ROFORMER_MODEL)
    asep.separate(job.upload_path)
    instrumental = next(
        (p for p in out_dir.glob("*.flac") if "instrumental" in p.name.lower()), None)
    if instrumental is None:
        raise RuntimeError("RoFormer stage produced no instrumental output")
    update(state="stage1", progress=weights["roformer"] * 100,
           stage_detail="RoFormer vocal removal done")

    # Stage 2: Demucs 6s on the instrumental, keep guitar + sum of the rest
    base = weights["roformer"]

    def cb(info):
        if info.get("state") != "end":
            return
        frac = ((info["model_idx_in_bag"] + 1) / info["models"]) if info.get("models") else 1.0
        shift = info.get("shift_idx", 0)
        progress = (base + (shift + frac) / 5 * weights["demucs"]) * 100
        update(state="stage2", progress=progress, stage_detail=f"guitar extraction pass {shift + 1}/5")

    sep = Separator(model="htdemucs_6s", shifts=5, progress=False, callback=cb)
    _, stems = sep.separate_audio_file(instrumental)

    job.duration = probe_duration(job.upload_path)
    guitar = stems["guitar"]
    no_guitar = torch.zeros_like(guitar)
    for name, tensor in stems.items():
        if name != "guitar":
            no_guitar += tensor

    for name, tensor in (("guitar", guitar), ("no_guitar", no_guitar)):
        size = write_flac(tensor, out_dir / f"{name}.flac")
        job.stems.append({"name": name, "file": f"{name}.flac", "bytes": size})
    instrumental.unlink()  # intermediate, not shown to the user
    update(stage_detail="done")


def run_job(job, update):
    if job.tier == "fast":
        run_fast(job, update)
    elif job.tier == "studio":
        run_studio(job, update)
    else:
        raise ValueError(f"unknown tier: {job.tier}")
