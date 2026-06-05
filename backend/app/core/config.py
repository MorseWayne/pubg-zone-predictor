from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_DIR = PROJECT_ROOT / "config"
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"
DEFAULT_DATABASE_PATH = DEFAULT_DATA_DIR / "pubg_zone_predictor.sqlite3"
DEFAULT_ASSETS_CACHE_DIR = DEFAULT_DATA_DIR / "assets" / "pubg-api-assets"
DEFAULT_TELEMETRY_CACHE_DIR = DEFAULT_DATA_DIR / "telemetry"


class Settings(BaseSettings):
    app_name: str = "PUBG Zone Predictor"
    app_version: str = "0.1.0"
    environment: str = Field(default="local", alias="APP_ENV")
    config_dir: Path = Field(default=DEFAULT_CONFIG_DIR, alias="APP_CONFIG_DIR")
    data_dir: Path = Field(default=DEFAULT_DATA_DIR, alias="APP_DATA_DIR")
    database_path: Path = Field(default=DEFAULT_DATABASE_PATH, alias="APP_DATABASE_PATH")
    assets_cache_dir: Path = Field(default=DEFAULT_ASSETS_CACHE_DIR, alias="PUBG_ASSETS_CACHE_DIR")
    assets_base_url: str = Field(
        default="https://raw.githubusercontent.com/pubg/api-assets/master",
        alias="PUBG_ASSETS_BASE_URL",
    )
    pubg_api_key: str | None = Field(default=None, alias="PUBG_API_KEY")
    pubg_api_base_url: str = Field(default="https://api.pubg.com", alias="PUBG_API_BASE_URL")
    pubg_api_timeout_seconds: int = Field(default=30, alias="PUBG_API_TIMEOUT_SECONDS")
    telemetry_cache_dir: Path = Field(
        default=DEFAULT_TELEMETRY_CACHE_DIR,
        alias="PUBG_TELEMETRY_CACHE_DIR",
    )
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        alias="APP_CORS_ORIGINS",
    )

    llm_enabled: bool = Field(default=False, alias="LLM_ENABLED")
    llm_base_url: str | None = Field(default=None, alias="LLM_BASE_URL")
    llm_api_key: str | None = Field(default=None, alias="LLM_API_KEY")
    llm_model: str | None = Field(default=None, alias="LLM_MODEL")
    llm_timeout_seconds: int = Field(default=15, alias="LLM_TIMEOUT_SECONDS")

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
