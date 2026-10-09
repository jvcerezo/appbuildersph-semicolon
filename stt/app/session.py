"""In-memory session transcript and broadcast hub for /ws/session.

Segment ids are assigned here so both engines share one sequence. A
non-final (live) Soniox update carries the id its final segment will get,
so clients can replace the live line in place when the final arrives.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque

from fastapi import WebSocket

log = logging.getLogger("linaw.session")

MAX_SEGMENTS = 20000  # roughly 30+ hours of speech; keeps memory bounded
ENGINES = ("soniox", "local")
STATES = ("listening", "processing", "offline", "audio_lost", "error")


class SessionHub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.segments: deque[dict] = deque(maxlen=MAX_SEGMENTS)
        self.next_id = 1
        self.session_id = uuid.uuid4().hex[:8]
        self.started_at = time.time()
        self.last_status: dict | None = None
        self.metrics: dict | None = None
        self._lock = asyncio.Lock()

    def reset(self) -> None:
        self.segments.clear()
        self.next_id = 1
        self.session_id = uuid.uuid4().hex[:8]
        self.started_at = time.time()
        self.metrics = None
        log.info("New session %s", self.session_id)

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        if self.last_status:
            await ws.send_text(json.dumps(self.last_status))

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, msg: dict) -> None:
        data = json.dumps(msg, ensure_ascii=False)
        dead = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_text(data), timeout=2)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def add_final(self, text: str, start: float, end: float, engine: str) -> dict | None:
        text = " ".join(text.split())
        if not text or engine not in ENGINES:
            return None
        async with self._lock:
            seg = {
                "type": "transcript",
                "id": f"s{self.next_id}",
                "text": text,
                "start": round(float(start), 2),
                "end": round(max(float(end), float(start)), 2),
                "final": True,
                "engine": engine,
            }
            self.next_id += 1
            self.segments.append(seg)
        await self.broadcast(seg)
        return seg

    async def add_partial(self, text: str, start: float, end: float, engine: str) -> None:
        if engine not in ENGINES:
            return
        await self.broadcast(
            {
                "type": "transcript",
                "id": f"s{self.next_id}",
                "text": " ".join(text.split()),
                "start": round(float(start), 2),
                "end": round(max(float(end), float(start)), 2),
                "final": False,
                "engine": engine,
            }
        )

    async def status(self, state: str, engine: str, message: str = "") -> None:
        if state not in STATES:
            state = "error"
        msg = {"type": "status", "state": state, "engine": engine, "message": message}
        self.last_status = msg
        log.info("status %s/%s %s", state, engine, message)
        await self.broadcast(msg)

    async def report_metrics(self, report: dict, cost_per_hour: float) -> dict | None:
        """The capturing page reports what only it can measure (bytes on the
        Soniox socket, first-word latency) every ~2 s; we add the cost
        estimate and broadcast the contract "metrics" message."""
        try:
            engine = str(report.get("engine"))
            session_seconds = max(0.0, float(report.get("session_seconds", 0)))
            cloud_bytes = max(0, int(report.get("cloud_bytes_sent", 0)))
            latency = report.get("avg_first_word_latency_ms")
            latency = None if latency is None else max(0, int(round(float(latency))))
        except (TypeError, ValueError):
            return None
        msg = {
            "type": "metrics",
            "engine": engine if engine in ENGINES else "local",
            "cloud_bytes_sent": cloud_bytes,
            "session_seconds": int(round(session_seconds)),
            "avg_first_word_latency_ms": latency,
            "cloud_cost_estimate": round(session_seconds * cost_per_hour / 3600, 4),
        }
        self.metrics = msg
        await self.broadcast(msg)
        return msg

    def transcript(self) -> dict:
        return {
            "session_id": self.session_id,
            "started_at": self.started_at,
            "segments": list(self.segments),
        }
