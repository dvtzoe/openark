from fastapi import APIRouter, Depends, HTTPException

from ...core.models import PersonaResponse
from ...core.registry import AgentNotFound, AgentRegistry
from .agents import get_registry

router = APIRouter(tags=["persona"])


@router.get("/agents/{name}/persona", response_model=PersonaResponse)
def get_persona(name: str, registry: AgentRegistry = Depends(get_registry)):
    try:
        core, evolving = registry.read_persona(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
    return PersonaResponse(core=core, evolving=evolving)


@router.post("/agents/{name}/persona/evolve", status_code=501)
def evolve_persona(name: str, registry: AgentRegistry = Depends(get_registry)):
    raise HTTPException(status_code=501, detail="persona evolution lands in phase 4")
