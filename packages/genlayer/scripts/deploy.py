#!/usr/bin/env python3
"""Deploy using the recoverable, source-verified release helper.

Prepare private production configuration with the release helper first. This
entrypoint never guesses an address or treats lifecycle status as execution success.
"""
from pathlib import Path
import subprocess

if __name__ == "__main__":
    root = Path(__file__).resolve().parents[3]
    raise SystemExit(subprocess.call(
        ["pnpm", "--filter", "@roque/core", "exec", "tsx", "scripts/release.ts", "genlayer"],
        cwd=root,
    ))
