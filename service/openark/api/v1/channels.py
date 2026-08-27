import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from ...core.models import ChannelItem, ChannelPushRequest
from ...core.registry import AgentNotFound, AgentRegistry
from .agents import get_registry

logger = logging.getLogger(__name__)

router = APIRouter(tags=["channels"])


def get_channels_store(request: Request):
    return request.app.state.modules["channels"]


def _require_agent(registry: AgentRegistry, name: str):
    try:
        registry.get(name)
    except AgentNotFound as err:
        raise HTTPException(status_code=404, detail="no such agent") from err


@router.get("/channels/{channel}", response_model=list[ChannelItem])
def read_channel(channel: str, store=Depends(get_channels_store)):
    try:
        items = store.list_channel(channel)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    result = []
    for item in items:
        try:
            result.append(ChannelItem(**item))
        except ValidationError as err:
            # Same "one bad item can't break the whole list" shape as
            # AgentRegistry.list() and SkillsModule.list() — a line that
            # parsed as valid JSON but is missing a required field is
            # still just one corrupted item, not a reason to 500 the
            # whole channel.
            logger.warning("skipping malformed item in channel #%s: %s", channel, err)
    return result


@router.post("/agents/{name}/channels/{channel}", response_model=ChannelItem, status_code=201)
def push_to_channel(
    name: str,
    channel: str,
    request: ChannelPushRequest,
    registry: AgentRegistry = Depends(get_registry),
    store=Depends(get_channels_store),
):
    _require_agent(registry, name)
    try:
        item = store.push(registry, name, channel, request.text, kind=request.kind)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return ChannelItem(**item)


@router.get("/agents/{name}/channels", response_model=list[str])
def list_subscriptions(
    name: str, registry=Depends(get_registry), store=Depends(get_channels_store)
):
    _require_agent(registry, name)
    return store.subscriptions(registry, name)


@router.post("/agents/{name}/channels/{channel}/subscribe", response_model=list[str])
def subscribe(
    name: str,
    channel: str,
    registry: AgentRegistry = Depends(get_registry),
    store=Depends(get_channels_store),
):
    _require_agent(registry, name)
    try:
        return store.subscribe(registry, name, channel)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@router.post("/agents/{name}/channels/{channel}/unsubscribe", response_model=list[str])
def unsubscribe(
    name: str,
    channel: str,
    registry: AgentRegistry = Depends(get_registry),
    store=Depends(get_channels_store),
):
    _require_agent(registry, name)
    try:
        return store.unsubscribe(registry, name, channel)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
