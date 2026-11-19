"""Reads one JSON request from stdin, writes one JSON result to stdout."""
from __future__ import annotations

import json
import sys

from .extract import extract


def main() -> None:
    req = json.load(sys.stdin)
    out = extract(
        root=req["root"],
        files=req["files"],
        python_path=req.get("pythonPath") or [],
        use_cache=req.get("useCache", True),
        workers=req.get("workers"),
        django_settings=req.get("djangoSettings"),
        api_clients=req.get("apiClients"),
    )
    json.dump(out, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
