import json

import pytest

from openark.core.config import get_settings, reset_settings_cache


def load(tmp_path, monkeypatch, payload):
    home = tmp_path / "openark"
    home.mkdir()
    (home / "openark.json").write_text(json.dumps(payload))
    monkeypatch.setenv("OPENARK_HOME", str(home))
    reset_settings_cache()
    try:
        return get_settings()
    finally:
        reset_settings_cache()


def test_valid_service_port(tmp_path, monkeypatch):
    settings = load(tmp_path, monkeypatch, {"servicePort": 9000})
    assert settings.service_port == 9000


@pytest.mark.parametrize("port", [None, {}, [], True, 0, -1, 70000, "8765", 8765.5])
def test_invalid_service_port_falls_back_to_default(tmp_path, monkeypatch, port):
    settings = load(tmp_path, monkeypatch, {"servicePort": port})
    assert settings.service_port == 8765


def test_invalid_json_falls_back_to_defaults(tmp_path, monkeypatch):
    home = tmp_path / "openark"
    home.mkdir()
    (home / "openark.json").write_text("{not json")
    monkeypatch.setenv("OPENARK_HOME", str(home))
    reset_settings_cache()
    try:
        settings = get_settings()
    finally:
        reset_settings_cache()
    assert settings.service_port == 8765
    assert settings.models == {}


def test_invalid_model_routes_fall_back_to_defaults(tmp_path, monkeypatch):
    settings = load(tmp_path, monkeypatch, {"models": {"extraction": {"bogus": 1}}})
    assert settings.models == {}


def test_valid_model_routes_are_kept(tmp_path, monkeypatch):
    settings = load(
        tmp_path,
        monkeypatch,
        {"models": {"extraction": {"provider": "openai", "model": "gpt-4o-mini"}}},
    )
    route = settings.models["extraction"]
    assert route.provider == "openai"
