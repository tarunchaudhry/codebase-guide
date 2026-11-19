from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import Order

WEBHOOK = os.environ.get("WEBHOOK_URL")


def notify(order: "Order") -> bool:
    """Send an order notification."""
    token = os.environ["NOTIFY_TOKEN"]
    return send(token)


def send(token):
    return bool(token)
