import shop.models
from shop import Order
from shop.notify import send as push

from .helpers import *


def create_order(items: list) -> Order:
    order = Order()
    order.submit()
    shop.models.Item()
    push("x")
    helper_fn()
    return order


def shadow(send):
    return send()


def late():
    from ..notify import notify
    return notify(None)
