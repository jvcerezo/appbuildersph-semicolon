"""Pre-download the local Whisper models so the server can run offline.

Run this while online, BEFORE the demo. At runtime the server loads models
from disk only (HF_HUB_OFFLINE=1, local_files_only) and never downloads.

    uv run scripts/download_models.py                      # models for both local engines (from .env)
    uv run scripts/download_models.py --engine whisperlivekit
    uv run scripts/download_models.py --engine chunked small medium

What gets downloaded:
  chunked         faster-whisper WHISPER_MODEL into WHISPER_MODEL_DIR
                  (MLX weights instead when LOCAL_STT_ENGINE=mlx-whisper)
  whisperlivekit  WLK_MODEL into WLK_MODEL_CACHE_DIR: the faster-whisper encoder
                  (both backends) and the PyTorch decoder weights <model>.pt
                  (SimulStreaming), so WLK_BACKEND can be switched offline
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_settings  # noqa: E402
from app.local_stt import mlx_repo_for  # noqa: E402


def download_chunked(models: list[str], engine: str, root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for model in models:
        print(f"[chunked/{engine}] '{model}' -> {root}", flush=True)
        if engine == "mlx-whisper":
            from huggingface_hub import snapshot_download

            path = snapshot_download(mlx_repo_for(model), local_dir=str(root / f"mlx-whisper-{model}"))
        else:
            from faster_whisper import download_model

            # cache_dir matches WhisperModel(download_root=...) so the server finds it offline.
            path = download_model(model, cache_dir=str(root))
        print(f"  ok: {path}")


def download_wlk(models: list[str], root: Path) -> None:
    from faster_whisper import download_model
    from whisperlivekit.whisper import _MODELS, _download

    root.mkdir(parents=True, exist_ok=True)
    for model in models:
        if model.endswith(".en"):
            sys.exit(f"'{model}' is English-only; WhisperLiveKit here needs a multilingual model (e.g. small).")
        print(f"[whisperlivekit] '{model}' -> {root}", flush=True)
        print(f"  encoder: {download_model(model, cache_dir=str(root))}")
        if model in _MODELS:
            # Same file name and checksum check WhisperLiveKit uses at load time.
            print(f"  decoder: {_download(_MODELS[model], str(root), False)}")
        else:
            print(f"  decoder: skipped ('{model}' has no SimulStreaming weights; use WLK_BACKEND=localagreement)")


def main() -> None:
    s = load_settings()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("models", nargs="*", help="model sizes (default: WHISPER_MODEL / WLK_MODEL from .env)")
    p.add_argument("--engine", default="all",
                   choices=["all", "chunked", "faster-whisper", "mlx-whisper", "whisperlivekit"])
    args = p.parse_args()

    if args.engine in ("faster-whisper", "mlx-whisper"):
        chunked_backend = args.engine
    else:
        chunked_backend = "mlx-whisper" if s.local_stt_engine == "mlx-whisper" else "faster-whisper"
    if args.engine in ("all", "chunked", "faster-whisper", "mlx-whisper"):
        download_chunked(args.models or [s.whisper_model], chunked_backend, s.whisper_model_dir)
    if args.engine in ("all", "whisperlivekit"):
        download_wlk(args.models or [s.wlk_model], s.wlk_model_cache_dir)
    print("Done. You can now run the server offline.")


if __name__ == "__main__":
    main()
