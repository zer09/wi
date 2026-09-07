#!/usr/bin/env python3
"""Local source/build gate. No provider calls, credentials, or login commands."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def static_checks() -> dict:
    manifest = tomllib.loads((ROOT / "Cargo.toml").read_text())
    assert manifest["package"]["version"] == "0.2.0"
    assert manifest["package"]["edition"] == "2024"
    source_files = list(ROOT.glob("src/**/*.rs")) + list(ROOT.glob("tests/**/*.rs")) + list(ROOT.glob("examples/**/*.rs"))
    names = []
    for path in source_files:
        text = path.read_text(encoding="utf-8")
        assert "\x00" not in text, path
        names.extend(re.findall(r"#\[(?:tokio::)?test\]\s*(?:async\s+)?fn\s+(\w+)", text))
    assert names and len(names) == len(set(names)), "duplicate test names or no tests"
    fixture_count = 0
    for path in (ROOT / "tests/fixtures").glob("*.jsonl"):
        for line in path.read_text().splitlines():
            value = json.loads(line)
            assert isinstance(value, dict) and isinstance(value.get("type"), str)
            fixture_count += 1
    gateway = (ROOT / "src/gateway.rs").read_text().lower()
    assert "openai_codex" not in gateway and "reqwest" not in gateway
    # Packaging safeguards, not a security audit or credential validity test.
    for path in ROOT.rglob("*"):
        if "target" in path.parts or ".git" in path.parts:
            continue
        assert path.name not in {"auth.json", "credentials.json", ".env"}, path
    return {"source_files": len(source_files), "rust_test_definitions": len(names), "fixture_events": fixture_count}


def main() -> int:
    details = static_checks()
    print("Source inventory / TOML / JSON checks:", json.dumps(details))
    if "--static-only" in sys.argv:
        print("Static checks only. Rust syntax, compilation and test behavior are NOT verified.")
        return 0
    cargo = shutil.which("cargo")
    if cargo is None:
        print("BLOCKED: cargo is not installed. No Rust checks were executed.", file=sys.stderr)
        return 2
    for arguments in [
        ["fmt", "--all", "--", "--check"],
        ["check", "--all-targets"],
        ["test", "--all-targets"],
        ["clippy", "--all-targets", "--", "-D", "warnings"],
        ["build", "--all-targets"],
        ["test", "--doc"],
    ]:
        command = [cargo, *arguments]
        print("Running:", " ".join(command), flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode:
            return result.returncode
    print("Rust checks finished. No live provider requests were made.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
