#!/usr/bin/env python3
"""Run the maintained linter with its new-runner SDK module-path compatibility fix.

Version 0.11.0 loads genlayer.py.get_schema unconditionally. Current pinned
runners expose the same real schema function at genlayer._internal.get_schema.
This adapter changes only that import fallback; AST/schema checks remain intact.
"""
import sys
from pathlib import Path

# Keep the offline test shim out of the SDK validator process.
package = Path(__file__).resolve().parent.parent
sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != package]

from genvm_linter.validate import validator
from genvm_linter.cli import cli

original = validator.load_sdk


def load_sdk(*args, **kwargs):
    try:
        return original(*args, **kwargs)
    except ModuleNotFoundError as error:
        if error.name != "genlayer.py":
            raise
        from genlayer._internal.get_schema import get_schema
        return get_schema, []


validator.load_sdk = load_sdk
if __name__ == "__main__":
    cli()
