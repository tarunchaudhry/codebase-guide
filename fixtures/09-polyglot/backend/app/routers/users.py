from fastapi import APIRouter

router = APIRouter(prefix="/users")


@router.get("/")
def list_users():
    return []


@router.post("/")
def create_user(body: dict):
    return body


@router.get("/me")
def me():
    return {"id": "me"}


@router.get("/{user_id}")
def get_user(user_id: str):
    return {"id": user_id}
