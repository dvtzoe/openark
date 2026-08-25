from typing import Protocol

from ..core.registry import AgentRegistry


class ServiceModule(Protocol):
    """Contract for service-side modules (the heavy lifting halves).

    A module owns its storage under the agent home and exposes logic that
    API endpoints call. It must never depend on other modules.
    """

    name: str

    def ready(self, registry: AgentRegistry) -> bool:
        """Return False to signal the module's dependencies are missing."""
        ...
