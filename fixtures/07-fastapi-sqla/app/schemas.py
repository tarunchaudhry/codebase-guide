from pydantic import BaseModel


class UserCreate(BaseModel):
    email: str


class UserOut(BaseModel):
    id: int
    email: str


class ItemOut(BaseModel):
    id: int
    title: str
