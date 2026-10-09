"""Entry point for the Linaw STT server.

    uv run fastapi dev        # auto-reload, http://127.0.0.1:8000
    uv run main.py            # uses HOST/PORT from .env
"""

import uvicorn

from app.config import load_settings
from app.main import app  # noqa: F401  (re-exported so `fastapi dev` / `fastapi run` find it)

if __name__ == "__main__":
    s = load_settings()
    uvicorn.run("app.main:app", host=s.host, port=s.port, log_level="info")
