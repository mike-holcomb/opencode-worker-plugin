#!/usr/bin/env python3
"""Materialize one isolated pilot input directory (standard library only)."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "cases.json"


def load_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read manifest {path}: {exc}") from exc
    if data.get("manifest_status") != "frozen-before-run":
        raise SystemExit("manifest must declare manifest_status=frozen-before-run")
    if not isinstance(data.get("cases"), list):
        raise SystemExit("manifest cases must be a list")
    return data


def get_case(manifest: dict, case_id: str) -> dict:
    matches = [case for case in manifest["cases"] if case.get("id") == case_id]
    if len(matches) != 1:
        raise SystemExit(f"unknown or duplicate case: {case_id}")
    return matches[0]


def safe_relative(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise SystemExit(f"unsafe relative path: {path}")
    return candidate


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and ".pytest_cache" not in path.parts:
            result[str(path.relative_to(root))] = sha256(path)
    return result


def materialize(
    manifest: dict,
    case: dict,
    out: Path,
    condition: str,
    run_id: str,
    manifest_dir: Path,
    state_path: Path,
) -> dict:
    if condition not in {"A", "B", "C"}:
        raise SystemExit("condition must be A, B, or C")
    if out.exists():
        raise SystemExit(f"refusing to reuse existing output directory: {out}")
    state_path = state_path.resolve()
    if state_path.exists():
        raise SystemExit(f"refusing to reuse existing state file: {state_path}")
    if state_path == out or out in state_path.parents:
        raise SystemExit("--state must point outside the prepared workdir")
    fixture_root = (manifest_dir / manifest["fixture_root"]).resolve()
    fixture_dir = (fixture_root / safe_relative(f"{case['id']}")).resolve()
    if fixture_root not in fixture_dir.parents or not fixture_dir.is_dir():
        raise SystemExit(f"fixture directory is missing or escapes fixture root: {case['id']}")
    expected_files = [safe_relative(path) for path in case.get("files", [])]
    if not expected_files:
        raise SystemExit(f"case has no fixture files: {case['id']}")
    for relative in expected_files:
        source = fixture_dir / relative
        if not source.is_file():
            raise SystemExit(f"fixture file is missing: {source}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir(mode=0o700)
    for relative in expected_files:
        destination = out / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fixture_dir / relative, destination)

    (out / "task.md").write_text(case["task"].rstrip() + "\n", encoding="utf-8")
    # This metadata is intentionally limited to routing information. It contains
    # no check definitions, expected strings, or generated solution.
    (out / "pilot-input.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "case_id": case["id"],
                "condition": condition,
                "run_id": run_id,
                "tier": case["tier"],
                "context": case["context"],
                "context_basis": case.get("context_basis", "unspecified"),
                "task_file": "task.md",
                "fixture_files": [str(path) for path in expected_files],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "case_id": case["id"],
                "condition": condition,
                "run_id": run_id,
                "prepared_workdir": str(out),
                "initial_files": snapshot(out),
                "note": "Authoritative baseline for changed-path checks; keep outside the worker workdir.",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {
        "case_id": case["id"],
        "condition": condition,
        "run_id": run_id,
        "workdir": str(out),
        "task_file": str(out / "task.md"),
        "state_file": str(state_path),
        "materialized_files": [str(path) for path in expected_files],
        "checks_materialized": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--case", required=True, dest="case_id")
    parser.add_argument("--condition", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path, help="authoritative baseline path outside --out")
    args = parser.parse_args(argv)
    manifest = load_manifest(args.manifest.resolve())
    case = get_case(manifest, args.case_id)
    result = materialize(
        manifest,
        case,
        args.out.resolve(),
        args.condition,
        args.run_id,
        args.manifest.resolve().parent,
        args.state,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        raise SystemExit(1)
