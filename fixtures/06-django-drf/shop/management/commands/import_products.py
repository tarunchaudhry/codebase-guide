from django.core.management.base import BaseCommand

from shop.models import Product


class Command(BaseCommand):
    help = "Import products from a CSV file"

    def handle(self, *args, **options):
        Product.objects.bulk_create([Product(name="Sample")])
