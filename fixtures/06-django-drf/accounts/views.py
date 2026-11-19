from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.views import APIView

from .models import Customer


def health(request):
    return JsonResponse({"ok": True})


@api_view(["GET", "POST"])
def profile(request):
    return JsonResponse({"phone": Customer.objects.get(user=request.user).phone})


class LoginView(APIView):
    def post(self, request):
        return JsonResponse({"token": "…"})
