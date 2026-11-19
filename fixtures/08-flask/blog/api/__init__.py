from flask import Blueprint

api_bp = Blueprint("api", __name__, url_prefix="/ignored-when-registered-with-prefix")

from . import posts  # noqa: E402,F401
