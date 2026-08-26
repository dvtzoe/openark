import pytest

from openark.core.registry import AgentRegistry
from openark.modules.channels import ChannelsStore, normalize_channel_name


@pytest.fixture()
def registry(tmp_path):
    reg = AgentRegistry(tmp_path)
    reg.ensure_layout()
    reg.create("chiai")
    reg.create("observer")
    return reg


@pytest.fixture()
def store(tmp_path):
    return ChannelsStore(tmp_path)


def test_normalize_channel_name():
    assert normalize_channel_name("#Team-Notes") == "team-notes"
    with pytest.raises(ValueError):
        normalize_channel_name("../escape")
    with pytest.raises(ValueError):
        normalize_channel_name("Bad Name")


def test_push_records_provenance(registry, store):
    item = store.push(registry, "chiai", "team", "User prefers vitest")
    assert item["source_agent"] == "chiai"
    assert item["kind"] == "memory"
    items = store.list_channel("team")
    assert len(items) == 1
    assert items[0]["text"] == "User prefers vitest"

    audit = (registry.agent_home("chiai") / "logs" / "audit.log").read_text()
    assert "channel.push #team" in audit


def test_push_rejects_empty_text(registry, store):
    with pytest.raises(ValueError):
        store.push(registry, "chiai", "team", "   ")


def test_subscribe_and_unsubscribe(registry, store):
    assert store.subscriptions(registry, "observer") == []
    subs = store.subscribe(registry, "observer", "team")
    assert subs == ["team"]
    manifest = registry.get("observer")
    assert manifest.channels.subscriptions == ["team"]

    store.subscribe(registry, "observer", "team")
    assert registry.get("observer").channels.subscriptions == ["team"]

    store.subscribe(registry, "observer", "second")
    assert store.unsubscribe(registry, "observer", "second") == ["team"]

    audit = (registry.agent_home("observer") / "logs" / "audit.log").read_text()
    assert "channel.subscribe #team" in audit
    assert "channel.unsubscribe #second" in audit


def test_subscribed_items_merge_with_provenance(registry, store):
    store.subscribe(registry, "observer", "team")
    store.push(registry, "chiai", "team", "User prefers vitest over jest")
    store.push(registry, "chiai", "team", "Deploy target is fly.io")
    store.push(registry, "observer", "team", "Observer note", kind="lesson")

    items = store.subscribed_items(registry, "observer")
    texts = [i["text"] for i in items]
    assert "User prefers vitest over jest" in texts
    assert "Deploy target is fly.io" in texts
    assert "Observer note" not in texts  # lessons are not merged into memory recall
    assert all(i["source_agent"] == "chiai" for i in items)
    assert all(i["channel"] == "team" for i in items)


def test_subscribed_items_keyword_filter(registry, store):
    store.subscribe(registry, "observer", "team")
    store.push(registry, "chiai", "team", "User prefers vitest over jest")
    store.push(registry, "chiai", "team", "Deploy target is fly.io")

    items = store.subscribed_items(registry, "observer", q="deploy target")
    assert [i["text"] for i in items] == ["Deploy target is fly.io"]


def test_subscribed_items_respects_limit(registry, store):
    store.subscribe(registry, "observer", "team")
    store.push(registry, "chiai", "team", "one")
    store.push(registry, "chiai", "team", "two")
    store.push(registry, "chiai", "team", "three")
    assert len(store.subscribed_items(registry, "observer", limit=2)) == 2
