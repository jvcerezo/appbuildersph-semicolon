"""Benchmark the local engines side by side on one audio/video file.

Each engine gets the same 16 kHz mono PCM in 100 ms chunks at real-time pace
(like the browser), one engine after the other so they do not compete for
the CPU. Prints, per engine:

  first text          seconds from the first audio chunk to the first text
  first-word latency  average time from sending audio to the first text
                      (partial or final) that covers it
  final lag           average time from sending a segment's last audio to
                      receiving that segment as final
  real-time factor    inference seconds per second of audio (< 1 keeps up)
  audio skipped       audio dropped by the backlog guard (0 = kept up)

and the final transcripts in two columns. Use it to pick the engine and
model size on the demo laptop.

    uv run scripts/bench_local.py clip.mp4
    uv run scripts/bench_local.py clip.mp4 --engines whisperlivekit --wlk-model medium
    uv run scripts/bench_local.py clip.mp4 --speed 2      # feed 2x real time (quick check)
"""

from __future__ import annotations

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")  # same as the server: never download here

import argparse  # noqa: E402
import asyncio  # noqa: E402
import dataclasses  # noqa: E402
import logging  # noqa: E402
import sys  # noqa: E402
import textwrap  # noqa: E402
import time  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import load_settings  # noqa: E402
from app.local_engine import TranscriptEvent, create_local_engine  # noqa: E402
from app.local_stt import SAMPLE_RATE, ModelUnavailableError  # noqa: E402

BYTES_PER_SECOND = SAMPLE_RATE * 2
CHUNK = BYTES_PER_SECOND // 10  # 100 ms


def decode_to_pcm16(path: str) -> bytes:
    # PyAV directly: faster_whisper.audio.decode_audio breaks on PyAV >= 16.
    import av

    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    out = bytearray()
    with av.open(path) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            sys.exit(f"No audio stream in {path}")
        for frame in container.decode(stream):
            for f in resampler.resample(frame):
                out += f.to_ndarray().astype("<i2").tobytes()
        for f in resampler.resample(None):
            out += f.to_ndarray().astype("<i2").tobytes()
    return bytes(out)


async def run_engine(kind: str, settings, pcm: bytes, speed: float) -> dict:
    s = dataclasses.replace(settings, local_stt_engine=kind)
    executor = ThreadPoolExecutor(max_workers=1)
    t_load = time.perf_counter()
    try:
        engine = await asyncio.get_running_loop().run_in_executor(executor, create_local_engine, s, executor)
    except ModelUnavailableError as e:
        return {"kind": kind, "error": str(e)}
    load_s = time.perf_counter() - t_load
    for name in list(logging.root.manager.loggerDict):  # WhisperLiveKit resets its levels on load
        if name.startswith(("whisperlivekit", "faster_whisper")):
            logging.getLogger(name).setLevel(logging.WARNING)
    info = engine.info()
    print(f"\n== {kind}: {info['model']}, {info['backend']}  (load + warm-up {load_s:.1f}s)", flush=True)

    duration = len(pcm) / BYTES_PER_SECOND
    finals: list[TranscriptEvent] = []
    first_word: list[float] = []
    final_lag: list[float] = []
    covered = 0.0
    first_text = None
    last_stats: dict = {}
    t0 = 0.0

    def sent_at(audio_t: float) -> float:  # wall time the audio at audio_t was sent
        return t0 + min(audio_t, duration) / speed

    async def on_event(ev: TranscriptEvent) -> None:
        nonlocal covered, first_text
        now = time.perf_counter()
        if ev.text and ev.end > covered:
            covered = ev.end
            first_word.append(now - sent_at(ev.end))
            if first_text is None:
                first_text = now - t0
        if ev.final:
            finals.append(ev)
            final_lag.append(now - sent_at(ev.end))
            print(f"  [{ev.start:7.2f}-{ev.end:7.2f}] {ev.text}", flush=True)

    async def on_stats(st: dict) -> None:
        last_stats.update(st)

    async def on_warning(msg: str) -> None:
        print(f"  ! {msg}", flush=True)

    await engine.start_session("bench", 0.0, on_event, on_stats, on_warning)
    t0 = time.perf_counter()
    for i in range(0, len(pcm), CHUNK):
        await engine.push_audio("bench", pcm[i:i + CHUNK])
        await asyncio.sleep(max(0.0, t0 + (i + CHUNK) / BYTES_PER_SECOND / speed - time.perf_counter()))
    await engine.end_session("bench", flush=True)
    await engine.aclose()
    executor.shutdown(wait=False)

    avg = lambda xs: sum(xs) / len(xs) if xs else None  # noqa: E731
    return {
        "kind": kind,
        "model": info["model"],
        "backend": info["backend"],
        "first_text": first_text,
        "first_word": avg(first_word),
        "final_lag": avg(final_lag),
        "rtf": last_stats.get("avg_rtf"),
        "skipped": last_stats.get("dropped_seconds", 0.0),
        "segments": len(finals),
        "text": " ".join(ev.text for ev in finals),
    }


def report(results: list[dict]) -> None:
    ok = [r for r in results if "error" not in r]
    for r in results:
        if "error" in r:
            print(f"\n{r['kind']}: UNAVAILABLE - {r['error']}")
    if not ok:
        return
    col = 44
    fmt_s = lambda x: "-" if x is None else f"{x:.2f} s"  # noqa: E731
    rows = [
        ("engine", lambda r: r["kind"]),
        ("backend", lambda r: str(r["backend"])),
        ("first text", lambda r: fmt_s(r["first_text"])),
        ("first-word latency", lambda r: fmt_s(r["first_word"])),
        ("final lag", lambda r: fmt_s(r["final_lag"])),
        ("real-time factor", lambda r: "-" if r["rtf"] is None else f"{r['rtf']:.2f}"),
        ("audio skipped", lambda r: f"{r['skipped'] or 0:.1f} s"),
        ("final segments", lambda r: str(r["segments"])),
    ]
    print("\n" + "=" * (22 + col * len(ok)))
    for label, f in rows:
        print(f"{label:<22}" + "".join(f"{f(r):<{col}}" for r in ok))
    print("-" * (22 + col * len(ok)))
    wrapped = [textwrap.wrap(r["text"], col - 2) or [""] for r in ok]
    for i in range(max(len(w) for w in wrapped)):
        print(" " * 22 + "".join(f"{(w[i] if i < len(w) else ''):<{col}}" for w in wrapped))
    for r in ok:
        if r["rtf"] is not None and r["rtf"] >= 0.9 or (r["skipped"] or 0) > 0:
            print(f"\nNote: {r['kind']} is close to or behind real time on this machine; "
                  "try a smaller model or a GPU.")


async def main_async(args) -> None:
    s = load_settings()
    overrides = {k: v for k, v in {
        "whisper_model": args.model, "wlk_model": args.wlk_model, "wlk_backend": args.wlk_backend,
        "whisper_device": args.device, "whisper_compute_type": args.compute_type,
    }.items() if v}
    if args.language:
        overrides.update(whisper_language=args.language, wlk_language=args.language)
    s = dataclasses.replace(s, **overrides)
    pcm = decode_to_pcm16(args.file)
    print(f"Audio: {args.file}  {len(pcm) / BYTES_PER_SECOND:.1f}s at {args.speed:g}x real time")
    results = [await run_engine(kind, s, pcm, args.speed) for kind in args.engines.split(",")]
    report(results)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.WARNING)
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file")
    p.add_argument("--engines", default="chunked,whisperlivekit",
                   help="comma-separated: chunked, whisperlivekit (default: both)")
    p.add_argument("--model", help="override WHISPER_MODEL (chunked)")
    p.add_argument("--wlk-model", help="override WLK_MODEL")
    p.add_argument("--wlk-backend", choices=["simulstreaming", "localagreement"])
    p.add_argument("--language", help="force a language for both engines (e.g. tl, en)")
    p.add_argument("--device")
    p.add_argument("--compute-type")
    p.add_argument("--speed", type=float, default=1.0, help="feed rate vs real time (default 1.0)")
    args = p.parse_args()
    if not os.path.isfile(args.file):
        sys.exit(f"No such file: {args.file}")
    for kind in args.engines.split(","):
        if kind not in ("chunked", "whisperlivekit"):
            sys.exit(f"Unknown engine {kind!r}; use chunked and/or whisperlivekit")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
