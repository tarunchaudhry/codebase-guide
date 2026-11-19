from flask import Flask

from .api import api_bp
from .auth import auth_bp
from .extensions import db
from .hooks import load_user


def create_app():
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///blog.db"
    db.init_app(app)
    app.before_request(load_user)
    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp, url_prefix="/api/v1")
    return app
