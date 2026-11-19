from django.db import models


class TimeStamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Category(models.Model):
    name = models.CharField(max_length=100)


class Product(TimeStamped):
    """Something we sell."""

    name = models.CharField(max_length=200)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="products")
    stock = models.IntegerField(default=0)


class Order(TimeStamped):
    customer = models.ForeignKey("accounts.Customer", on_delete=models.CASCADE)


class OrderItem(models.Model):
    order = models.ForeignKey("Order", on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField()
