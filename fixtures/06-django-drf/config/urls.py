from django.contrib import admin
from django.urls import include, path

from accounts import views as account_views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("shop.urls")),
    path("accounts/", include("accounts.urls")),
    path("health/", account_views.health),
]
