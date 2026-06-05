from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_DIR = PROJECT_ROOT / "config"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_DATABASE_PATH = DEFAULT_DATA_DIR / "pubg_zone_predictor.sqlite3"


class Settings(BaseSettings):
    app_name: str = "PUBG Zone Predictor"
    app_version: str = "0.1.0"
    environment: str = Field(default="local", alias="APP_ENV")
    config_dir: Path = Field(default=DEFAULT_CONFIG_DIR, alias="APP_CONFIG_DIR")
    data_dir: Path = Field(default=DEFAULT_DATA_DIR, alias="APP_DATA_DIR")
    database_path: Path = Field(default=DEFAULT_DATABASE_PATH, alias="APP_DATABASE_PATH")
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        alias="APP_CORS_ORIGINS",
    )

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
