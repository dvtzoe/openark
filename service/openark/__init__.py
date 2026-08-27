from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("openark-service")
except PackageNotFoundError:
    # Running from a source checkout without an editable install
    # (e.g. a bare `python -m openark...` in a dev container).
    __version__ = "0.0.0-dev"
