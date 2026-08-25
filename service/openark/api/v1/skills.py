from fastapi import APIRouter, Depends, HTTPException

from ...core.models import SkillsResponse
from ...core.registry import AgentRegistry
from .agents import get_registry

router = APIRouter(tags=["skills"])


@router.get("/agents/{name}/skills", response_model=SkillsResponse)
def list_skills(name: str, registry: AgentRegistry = Depends(get_registry)):
    if not registry.exists(name):
        raise HTTPException(status_code=404, detail="no such agent")
    return SkillsResponse(skills=[])
