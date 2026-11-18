"""Runs the server: python -m nightcap"""

import logging

import uvicorn

from .config import PORT

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
uvicorn.run("nightcap.api:app", host="0.0.0.0", port=PORT, log_config=None, access_log=True)
