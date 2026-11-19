import environ
from decouple import config
from pydantic_settings import BaseSettings, SettingsConfigDict

env = environ.Env()
DEBUG = env.bool("DEBUG", default=False)
SECRET = env("SECRET_KEY")
REDIS = config("REDIS_URL")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHOP_")
    db_url: str = "sqlite://"
