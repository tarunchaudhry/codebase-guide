from flask import Blueprint, request, session

from .models import User

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


@auth_bp.before_request
def check_csrf():
    if request.method == "POST" and not request.form.get("csrf"):
        return "bad csrf", 400


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    user = User.query.filter_by(username=request.form.get("username")).first()
    session["user_id"] = user.id if user else None
    return "ok"
