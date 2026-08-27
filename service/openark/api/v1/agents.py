from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from ...core.config import get_settings
from ...core.models import AgentCreateRequest, AgentManifest
from ...core.registry import AgentAlreadyExists, AgentNotFound, AgentRegistry, UnknownPersona

router = APIRouter(tags=["agents"])


def get_registry() -> AgentRegistry:
    return AgentRegistry(get_settings().root)


def require_agent(registry: AgentRegistry, name: str) -> Path:
    """Raise 404 if `name` isn't a real agent; otherwise return its home
    directory. The single shared implementation of a check every API file
    used to duplicate — see docs/plans/0003-findings-service-api.md #1."""
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
    return registry.agent_home(name)


@router.get("/agents", response_model=list[AgentManifest])
def list_agents(registry: AgentRegistry = Depends(get_registry)):
    return registry.list()


@router.post("/agents", response_model=AgentManifest, status_code=201)
def create_agent(
    request: AgentCreateRequest,
    registry: AgentRegistry = Depends(get_registry),
):
    try:
        return registry.create(request.name, request.description, persona=request.persona)
    except AgentAlreadyExists as err:
        raise HTTPException(status_code=409, detail="agent already exists") from err
    except UnknownPersona as err:
        raise HTTPException(status_code=400, detail=f"unknown persona: {err.args[0]}") from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.get("/agents/{name}", response_model=AgentManifest)
def get_agent(name: str, registry: AgentRegistry = Depends(get_registry)):
    try:
        return registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err


@router.delete("/agents/{name}", status_code=204)
def delete_agent(name: str, registry: AgentRegistry = Depends(get_registry)):
    try:
        registry.delete(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
