from fastapi import FastAPI

from .api.v1.router import router as v1_router
from .core.config import get_settings
from .core.registry import AgentRegistry


def create_app() -> FastAPI:
    app = FastAPI(
        title="openark service",
        version="0.1.0",
        description="Local service backing openark agents (memory, persona, lessons, skills).",
    )
    settings = get_settings()
    registry = AgentRegistry(settings.root)
    registry.ensure_layout()

    app.include_router(v1_router)
    return app


app = create_app()
