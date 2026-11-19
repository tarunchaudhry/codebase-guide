from shop.services.orders import create_order


def test_create():
    assert create_order([])
