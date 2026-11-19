from flask import jsonify, request
from flask.views import MethodView

from ..extensions import db
from ..models import Post
from . import api_bp


@api_bp.get("/posts")
def list_posts():
    return jsonify([p.title for p in Post.query.all()])


@api_bp.post("/posts")
def create_post():
    db.session.add(Post(title=request.json["title"]))
    db.session.commit()
    return "", 201


class PostView(MethodView):
    def get(self, post_id):
        return jsonify(Post.query.get_or_404(post_id).title)

    def delete(self, post_id):
        Post.query.filter_by(id=post_id).delete()
        return "", 204


api_bp.add_url_rule("/posts/<int:post_id>", view_func=PostView.as_view("post"))
