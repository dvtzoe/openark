from fastapi import APIRouter, Depends, HTTPException, Request

from ...core.models import (
    MemoryCreateRequest,
    MemoryIngestRequest,
    MemoryIngestResponse,
    MemoryItem,
    MemoryMutation,
    MemoryRecallResponse,
)
from ...core.registry import AgentNotFound, AgentRegistry
from ...modules.channels import ChannelsStore
from ...modules.memory import MemoryModule
from .agents import get_registry

router = APIRouter(tags=["memory"])

UNAVAILABLE = "memory module unavailable (install openark-service[memory])"


def get_memory_module(request: Request) -> MemoryModule:
    return request.app.state.modules.memory


def get_channels_store(request: Request) -> ChannelsStore:
    return request.app.state.modules.channels


def _require_agent(registry: AgentRegistry, name: str):
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err
    return registry.agent_home(name)


def _require_module(module: MemoryModule, registry: AgentRegistry) -> MemoryModule:
    if not module.ready(registry):
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    return module


@router.get("/agents/{name}/memory/recall", response_model=MemoryRecallResponse)
def recall(
    name: str,
    q: str = "",
    limit: int = 10,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_memory_module),
    channels=Depends(get_channels_store),
):
    agent_home = _require_agent(registry, name)
    module = _require_module(module, registry)
    memories = module.recall(agent_home, name, q=q, limit=limit)
    remaining = limit - len(memories)
    if remaining > 0:
        for item in channels.subscribed_items(registry, name, q=q, limit=remaining):
            memories.append(
                MemoryItem(
                    id=str(item.get("id", "")),
                    text=str(item.get("text", "")),
                    score=0.0,
                    source_agent=str(item.get("source_agent", "")) or None,
                )
            )
    return MemoryRecallResponse(memories=memories)


@router.post("/agents/{name}/memory", response_model=MemoryMutation, status_code=201)
def add_memory(
    name: str,
    request: MemoryCreateRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_memory_module),
):
    agent_home = _require_agent(registry, name)
    module = _require_module(module, registry)
    result = module.add(agent_home, name, request.text, project=request.project)
    if result is None:
        raise HTTPException(status_code=502, detail="memory write failed")
    return result


@router.post("/agents/{name}/memory/ingest", response_model=MemoryIngestResponse)
def ingest(
    name: str,
    request: MemoryIngestRequest,
    registry: AgentRegistry = Depends(get_registry),
    module=Depends(get_memory_module),
):
    agent_home = _require_agent(registry, name)
    module = _require_module(module, registry)
    return module.ingest(agent_home, name, request.text, project=request.project)
