from django.urls import path, re_path

from . import views

urlpatterns = [
    path("products/", views.ProductListView.as_view(), name="product-list"),
    re_path(r"^products/(?P<pk>\d+)/$", views.product_detail),
]
