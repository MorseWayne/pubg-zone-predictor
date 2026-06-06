from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.assets import router as assets_router
from app.api.config import router as config_router
from app.api.health import router as health_router
from app.api.hotspots import router as hotspots_router
from app.api.ingest import router as ingest_router
from app.api.training import router as training_router
from app.core.config import get_settings
from app.core.errors import register_error_handlers


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version=settings.app_version)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(health_router)
    app.include_router(config_router)
    app.include_router(assets_router)
    app.include_router(ingest_router)
    app.include_router(hotspots_router)
    app.include_router(training_router)
    return app


app = create_app()
