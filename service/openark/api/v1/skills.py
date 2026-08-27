from fastapi import APIRouter, Depends, HTTPException, Request

from ...core.models import (
    DistillRequest,
    DistillResponse,
    SkillsResponse,
    SkillSummary,
    SkillVerifyResponse,
)
from ...core.registry import AgentNotFound, AgentRegistry
from ...modules.skills import SkillsModule
from .agents import get_registry

router = APIRouter(tags=["skills"])


def get_skills_module(request: Request) -> SkillsModule:
    return request.app.state.modules.skills


def _require_agent(registry: AgentRegistry, name: str):
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err


@router.get("/agents/{name}/skills", response_model=SkillsResponse)
def list_skills(
    name: str,
    drafts: bool = False,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_skills_module),
):
    _require_agent(registry, name)
    skills = module.list(registry.agent_home(name), include_drafts=drafts)
    return SkillsResponse(
        skills=[
            SkillSummary(name=s.name, description=s.description, status=s.status) for s in skills
        ]
    )


@router.post("/agents/{name}/skills/distill", response_model=DistillResponse)
def distill_skill(
    name: str,
    request: DistillRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_skills_module),
):
    _require_agent(registry, name)
    return module.distill(registry, name, request.trace)


@router.post("/agents/{name}/skills/{slug}/verify", response_model=SkillVerifyResponse)
def verify_skill(
    name: str,
    slug: str,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_skills_module),
):
    _require_agent(registry, name)
    return module.verify(registry, name, slug)
