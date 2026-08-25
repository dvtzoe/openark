from fastapi import APIRouter, Depends, HTTPException

from ...core.models import ChannelItem, ChannelPushRequest
from ...core.registry import AgentRegistry
from .agents import get_registry

router = APIRouter(tags=["channels"])


@router.get("/channels/{channel}", response_model=list[ChannelItem])
def read_channel(channel: str, registry: AgentRegistry = Depends(get_registry)):
    if "/" in channel or channel.startswith("."):
        raise HTTPException(status_code=400, detail="invalid channel name")
    return []


@router.post("/agents/{name}/channels/{channel}", status_code=501)
def push_to_channel(
    name: str,
    channel: str,
    request: ChannelPushRequest,
    registry: AgentRegistry = Depends(get_registry),
):
    raise HTTPException(status_code=501, detail="channels land in phase 7")
