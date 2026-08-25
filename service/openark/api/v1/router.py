from fastapi import APIRouter

from . import agents, channels, health, lessons, memory, persona, skills

router = APIRouter(prefix="/v1")
router.include_router(health.router)
router.include_router(agents.router)
router.include_router(memory.router)
router.include_router(persona.router)
router.include_router(lessons.router)
router.include_router(skills.router)
router.include_router(channels.router)
