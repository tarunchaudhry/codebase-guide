from flask import g, session


def load_user():
    g.user_id = session.get("user_id")
