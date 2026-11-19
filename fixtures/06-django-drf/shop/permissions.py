from rest_framework.permissions import BasePermission


class IsStaffOrReadOnly(BasePermission):
    def has_permission(self, request, view):
        return request.method == "GET" or request.user.is_staff
