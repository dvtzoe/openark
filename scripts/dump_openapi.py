"""Dump the service OpenAPI spec to a JSON file for TS type generation.

Usage: python scripts/dump_openapi.py [output-path]
"""

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "service"))

import os


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/openark-openapi.json")
    with tempfile.TemporaryDirectory() as home:
        os.environ["OPENARK_HOME"] = home
        from openark.app import create_app

        app = create_app()
        spec = app.openapi()
    out.write_text(json.dumps(spec, indent=2) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
