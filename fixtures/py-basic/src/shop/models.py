from .notify import notify


class Base:
    """Persistence base class."""

    def save(self):
        return self.validate()

    def validate(self):
        return True


class Order(Base):
    def total(self, items):
        return sum(i for i in items if i > 0)

    def submit(self):
        self.save()
        return notify(self)


class Item:
    pass
