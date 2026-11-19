import os
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .db import get_db
from .models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


def get_current_user(db: Session = Depends(get_db), token: str = Depends(oauth2_scheme)) -> User:
    user = db.query(User).filter(User.email == token).first()
    if user is None:
        raise HTTPException(status_code=401)
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.email.endswith("@admin"):
        raise HTTPException(status_code=403)
    return user


def verify_api_key(x_api_key: Annotated[str, Header()]) -> None:
    if x_api_key != os.environ["API_KEY"]:
        raise HTTPException(status_code=401)
