from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.assets import router as assets_router
from app.api.config import router as config_router
from app.api.health import router as health_router
from app.api.hotspots import router as hotspots_router
from app.api.ingest import router as ingest_router
from app.api.opponents import router as opponents_router
from app.api.player_bindings import router as player_bindings_router
from app.api.predict import router as predict_router
from app.api.training import router as training_router
from app.core.config import Settings, get_settings
from app.core.errors import register_error_handlers
from app.db.migrations import initialize_database
from app.services.season_backfill import SeasonBackfill
from app.services.team_day_fills import TeamDayFills


def create_app(settings: Settings | None = None, *, background_enabled: bool = True) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        initialize_database(settings.database_path)
        # Constructors allocate locks only. Workers start on a view/ensure request, never here.
        app.state.season_backfill = (
            SeasonBackfill(settings.database_path, settings.telemetry_cache_dir)
            if background_enabled
            else None
        )
        app.state.team_day_fills = TeamDayFills(settings.database_path, enabled=background_enabled)
        try:
            yield
        finally:
            if app.state.season_backfill:
                app.state.season_backfill.close()
            app.state.team_day_fills.close()

    app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)
    app.dependency_overrides[get_settings] = lambda: settings
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
    app.include_router(opponents_router)
    app.include_router(player_bindings_router)
    app.include_router(hotspots_router)
    app.include_router(training_router)
    app.include_router(predict_router)
    return app


app = create_app()
