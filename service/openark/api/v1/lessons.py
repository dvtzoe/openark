from fastapi import APIRouter, Depends, HTTPException

from ...core.models import LessonsResponse, ReflectRequest
from ...core.registry import AgentRegistry
from .agents import get_registry

router = APIRouter(tags=["lessons"])


@router.get("/agents/{name}/lessons", response_model=LessonsResponse)
def list_lessons(name: str, active: bool = True, registry: AgentRegistry = Depends(get_registry)):
    if not registry.exists(name):
        raise HTTPException(status_code=404, detail="no such agent")
    return LessonsResponse(lessons=[])


@router.post("/agents/{name}/lessons/reflect", status_code=501)
def reflect(name: str, request: ReflectRequest, registry: AgentRegistry = Depends(get_registry)):
    raise HTTPException(status_code=501, detail="reflection lands in phase 5")
