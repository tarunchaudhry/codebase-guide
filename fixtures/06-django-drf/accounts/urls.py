from django.urls import path

from . import views

urlpatterns = [
    path("profile/", views.profile),
    path("login/", views.LoginView.as_view()),
]
