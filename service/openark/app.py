from dataclasses import dataclass

from fastapi import FastAPI

from . import __version__
from .api.v1.router import router as v1_router
from .core.config import get_settings
from .core.llm import build_task_runner
from .core.registry import AgentRegistry
from .modules.channels import ChannelsStore
from .modules.lessons import LessonsModule
from .modules.memory import MemoryModule
from .modules.persona import PersonaModule
from .modules.skills import SkillsModule


@dataclass
class ServiceModules:
    """One named field per module — replaces a string-keyed dict so a typo
    in a lookup (e.g. "memroy") is a static attribute error, not a
    KeyError at first request."""

    memory: MemoryModule
    persona: PersonaModule
    lessons: LessonsModule
    skills: SkillsModule
    channels: ChannelsStore


def build_modules() -> ServiceModules:
    runner = build_task_runner()
    settings = get_settings()
    return ServiceModules(
        memory=MemoryModule(runner=runner),
        persona=PersonaModule(runner=runner),
        lessons=LessonsModule(runner=runner),
        skills=SkillsModule(runner=runner),
        channels=ChannelsStore(settings.root),
    )


def create_app() -> FastAPI:
    app = FastAPI(
        title="openark service",
        version=__version__,
        description="Local service backing openark agents (memory, persona, lessons, skills).",
    )
    settings = get_settings()
    registry = AgentRegistry(settings.root)
    registry.ensure_layout()
    app.state.registry = registry
    app.state.modules = build_modules()

    app.include_router(v1_router)
    return app


app = create_app()
