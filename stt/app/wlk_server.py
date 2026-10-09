"""Subprocess entry point for WLK_EMBEDDED=false.

    python -m app.wlk_server <whisperlivekit-server arguments>

Runs WhisperLiveKit's own server after pinning the faster-whisper device
(LINAW_CT2_DEVICE / LINAW_CT2_COMPUTE), which the stock CLI cannot do.
Started and stopped by wlk_engine.WhisperLiveKitSubprocessEngine.
"""

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")

from app.wlk_engine import pin_ct2_device  # noqa: E402

pin_ct2_device(os.environ.get("LINAW_CT2_DEVICE", "cpu"), os.environ.get("LINAW_CT2_COMPUTE", "int8"))

from whisperlivekit import basic_server  # noqa: E402  (parses sys.argv on import)

if __name__ == "__main__":
    basic_server.main()
