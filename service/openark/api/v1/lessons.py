from fastapi import APIRouter, Depends, HTTPException, Request

from ...core.models import (
    Lesson,
    LessonAddRequest,
    LessonAddResponse,
    LessonHitsRequest,
    LessonHitsResponse,
    LessonRetireResponse,
    LessonsResponse,
    ReflectRequest,
    ReflectResponse,
)
from ...core.registry import AgentNotFound, AgentRegistry
from ...modules.lessons import LessonsModule
from .agents import get_registry

router = APIRouter(tags=["lessons"])


def get_lessons_module(request: Request) -> LessonsModule:
    return request.app.state.modules.lessons


def _require_agent(registry: AgentRegistry, name: str):
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err


@router.get("/agents/{name}/lessons", response_model=LessonsResponse)
def list_lessons(
    name: str,
    active: bool = True,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_lessons_module),
):
    _require_agent(registry, name)
    entries = module.list(registry.agent_home(name), active_only=active)
    return LessonsResponse(
        lessons=[
            Lesson(id=e.id, rule=e.rule, hits=e.hits, status=e.status, source=e.source)
            for e in entries
        ]
    )


@router.post("/agents/{name}/lessons/reflect", response_model=ReflectResponse)
def reflect(
    name: str,
    request: ReflectRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_lessons_module),
):
    _require_agent(registry, name)
    failures = [f.model_dump() for f in request.failures]
    result = module.reflect(registry, name, failures, request.messages)
    return ReflectResponse(**result)


@router.post("/agents/{name}/lessons", response_model=LessonAddResponse, status_code=201)
def add_lesson(
    name: str,
    request: LessonAddRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_lessons_module),
):
    _require_agent(registry, name)
    try:
        result = module.add(registry, name, request.rule, source=request.source)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    if result["added"] is None:
        return LessonAddResponse(added=None, reason="duplicate")
    return LessonAddResponse(added=result["added"], reason=None)


@router.post("/agents/{name}/lessons/{lesson_id}/retire", response_model=LessonRetireResponse)
def retire_lesson(
    name: str,
    lesson_id: str,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_lessons_module),
):
    _require_agent(registry, name)
    return LessonRetireResponse(**module.retire(registry, name, lesson_id))


@router.post("/agents/{name}/lessons/hits", response_model=LessonHitsResponse)
def register_hits(
    name: str,
    request: LessonHitsRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_lessons_module),
):
    _require_agent(registry, name)
    return LessonHitsResponse(
        **module.register_hits(registry, name, request.ids, request.session_id)
    )
