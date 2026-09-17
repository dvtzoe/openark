from fastapi import Request


def preferred_model(request: Request) -> str | None:
    """The session's selected model, forwarded by the plugin as
    "provider/model" in the x-openark-model header.

    Background tasks fall back to it when no explicit per-task route is
    configured, so learning and persona updates work even when opencode has
    no small_model set. Malformed hints are ignored (None), never fatal.
    """
    value = request.headers.get("x-openark-model", "").strip()
    if not value or "/" not in value:
        return None
    return value
