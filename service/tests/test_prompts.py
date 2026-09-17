import pytest

from openark.core.prompts import (
    PromptFormatError,
    PromptNotFound,
    load_prompt,
    parse_prompt,
    render,
)


def test_parse_prompt_frontmatter():
    spec = parse_prompt(
        "---\n"
        "name: reflection\n"
        "version: 2\n"
        "task: reflection\n"
        "---\n"
        "Body with {failures} placeholder.\n"
    )
    assert spec.name == "reflection"
    assert spec.version == 2
    assert spec.task == "reflection"
    assert spec.body == "Body with {failures} placeholder."


def test_parse_prompt_missing_key():
    with pytest.raises(PromptFormatError, match="task"):
        parse_prompt("---\nname: x\nversion: 1\n---\nbody")


def test_parse_prompt_bad_version():
    with pytest.raises(PromptFormatError, match="version"):
        parse_prompt("---\nname: x\nversion: one\ntask: t\n---\nbody")


def test_parse_prompt_no_frontmatter():
    with pytest.raises(PromptFormatError, match="frontmatter"):
        parse_prompt("just a body")


def test_load_prompt_shipped(tmp_path):
    spec = load_prompt("extraction")
    assert spec.name == "extraction"
    assert spec.task == "extraction"
    assert "{conversation}" in spec.body


def test_load_prompt_missing():
    with pytest.raises(PromptNotFound):
        load_prompt("no-such-prompt")


def test_load_prompt_name_mismatch(tmp_path):
    (tmp_path / "wrong.md").write_text("---\nname: other\nversion: 1\ntask: t\n---\nbody\n")
    with pytest.raises(PromptFormatError, match="declares name"):
        load_prompt("wrong", prompts_dir=tmp_path)


def test_render_fills_placeholders():
    spec = parse_prompt("---\nname: x\nversion: 1\ntask: t\n---\nHello {who}, {what}?")
    assert render(spec, who="a", what="b") == "Hello a, b?"


def test_render_does_not_substitute_placeholders_inside_values():
    spec = parse_prompt("---\nname: x\nversion: 1\ntask: t\n---\n{a} and {b}")
    assert render(spec, a="{b}", b="B") == "{b} and B"


def test_render_missing_placeholder():
    spec = parse_prompt("---\nname: x\nversion: 1\ntask: t\n---\nHello {who}")
    with pytest.raises(PromptFormatError, match="who"):
        render(spec)
