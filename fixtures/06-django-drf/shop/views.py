from django.views.generic import ListView
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated

from .models import Order, Product
from .permissions import IsStaffOrReadOnly
from .serializers import OrderSerializer, ProductSerializer


class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer
    permission_classes = [IsAuthenticated, IsStaffOrReadOnly]

    @action(detail=True, methods=["post"])
    def restock(self, request, pk=None):
        product = Product.objects.get(pk=pk)
        Product.objects.filter(pk=product.pk).update(stock=product.stock + 10)


class OrderViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Order.objects.all()
    serializer_class = OrderSerializer

    def list(self, request):
        return Order.objects.filter(customer__user=request.user)


class ProductListView(ListView):
    model = Product


def product_detail(request, pk):
    return Product.objects.get(pk=pk)
