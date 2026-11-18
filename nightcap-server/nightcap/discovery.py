"""How a TV finds the server on the home network: it sends "NIGHTCAP?" to everyone on the
network (UDP broadcast, DISCOVERY_PORT) and the server answers with its name and the port to use.
The TV takes the server's address from where the answer came from.

(In the cluster, the pod uses the node's own network so it hears the TV's broadcast.)
"""

import json
import logging
import socket
import threading

from .config import ADVERTISE_PORT, DISCOVERY_PORT, OPEN_JOIN, SERVER_NAME

log = logging.getLogger(__name__)

ASK = b"NIGHTCAP?"


def answer():
    return json.dumps({"service": "nightcap", "name": SERVER_NAME, "port": ADVERTISE_PORT,
                       "openJoin": OPEN_JOIN}).encode()


def listen():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", DISCOVERY_PORT))
    log.info("Answering TVs looking for a server on UDP %d", DISCOVERY_PORT)
    while True:
        try:
            data, sender = sock.recvfrom(64)
            if data.strip() == ASK:
                sock.sendto(answer(), sender)
        except Exception:
            log.exception("Discovery")


def start():
    if DISCOVERY_PORT:
        threading.Thread(target=listen, name="discovery", daemon=True).start()
