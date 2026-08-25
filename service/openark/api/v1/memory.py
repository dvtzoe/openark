from fastapi import APIRouter, Depends, HTTPException

from ...core.models import MemoryCreateRequest, MemoryRecallResponse
from ...core.registry import AgentRegistry
from .agents import get_registry

router = APIRouter(tags=["memory"])


@router.get("/agents/{name}/memory/recall", response_model=MemoryRecallResponse)
def recall(
    name: str,
    q: str = "",
    limit: int = 10,
    registry: AgentRegistry = Depends(get_registry),
):
    if not registry.exists(name):
        raise HTTPException(status_code=404, detail="no such agent")
    return MemoryRecallResponse(memories=[])


@router.post("/agents/{name}/memory", status_code=501)
def add_memory(
    name: str,
    request: MemoryCreateRequest,
    registry: AgentRegistry = Depends(get_registry),
):
    raise HTTPException(status_code=501, detail="memory write lands in phase 2")


@router.post("/agents/{name}/memory/ingest", status_code=501)
def ingest(
    name: str,
    request: MemoryCreateRequest,
    registry: AgentRegistry = Depends(get_registry),
):
    raise HTTPException(status_code=501, detail="extraction lands in phase 2")
