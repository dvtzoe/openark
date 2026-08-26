import pytest

memory_module = pytest.importorskip("openark.modules.memory", reason="memory deps missing")

pytestmark = pytest.mark.skipif(
    not memory_module.memory_dependencies_installed(),
    reason="mem0/chromadb/fastembed not installed",
)

from openark.modules.memory import MemoryModule  # noqa: E402


@pytest.fixture()
def module():
    return MemoryModule(store_factory=None, runner=None)


def test_mem0_roundtrip(tmp_path, module):
    home = tmp_path / "agents" / "chiai"
    home.mkdir(parents=True)
    (home / "data").mkdir()

    added = module.add(home, "chiai", "User's favorite editor is neovim.")
    assert added["event"] == "ADD"

    module.add(home, "chiai", "User dislikes tabs and prefers spaces.")

    hits = module.recall(home, "chiai", q="which editor does the user like?", limit=1)
    assert hits
    assert "neovim" in hits[0].text.lower()

    listed = module.recall(home, "chiai", q="", limit=5)
    assert len(listed) == 2


def test_mem0_ingest_without_llm_is_noop(tmp_path, module):
    home = tmp_path / "agents" / "chiai"
    home.mkdir(parents=True)
    (home / "data").mkdir()
    result = module.ingest(home, "chiai", "user: I use vitest")
    assert result == {"added": 0, "facts": [], "reason": "no-model"}
    assert module.recall(home, "chiai", q="", limit=5) == []
