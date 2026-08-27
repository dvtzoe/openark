from fastapi import APIRouter, Depends, HTTPException, Request

from ...core.models import PersonaEvolveRequest, PersonaEvolveResponse, PersonaResponse
from ...core.registry import AgentNotFound, AgentRegistry
from ...modules.persona import PersonaModule
from .agents import get_registry

router = APIRouter(tags=["persona"])


def get_persona_module(request: Request) -> PersonaModule:
    return request.app.state.modules.persona


@router.get("/agents/{name}/persona", response_model=PersonaResponse)
def get_persona(name: str, registry: AgentRegistry = Depends(get_registry)):
    try:
        core, evolving = registry.read_persona(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
    return PersonaResponse(core=core, evolving=evolving)


@router.post("/agents/{name}/persona/evolve", response_model=PersonaEvolveResponse)
def evolve_persona(
    name: str,
    request: PersonaEvolveRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_persona_module),
):
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
    result = module.evolve(registry, name, request.signals, threshold=request.threshold)
    replaced = [{"old": old, "new": new} for old, new in result.get("replaced", [])]
    return PersonaEvolveResponse(**{**result, "replaced": replaced})


@router.get("/personas", response_model=list[str])
def list_bundled_personas(registry: AgentRegistry = Depends(get_registry)):
    return registry.bundled_personas()
