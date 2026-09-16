#!/usr/bin/env python3
"""Evaluate frozen observable checks for one prepared pilot directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "cases.json"


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read JSON {path}: {exc}") from exc


def get_case(manifest: dict, case_id: str) -> dict:
    matches = [case for case in manifest.get("cases", []) if case.get("id") == case_id]
    if len(matches) != 1:
        raise SystemExit(f"unknown or duplicate case: {case_id}")
    return matches[0]


def safe_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise SystemExit(f"unsafe check path: {relative}")
    path = (root / candidate).resolve()
    if root.resolve() not in path.parents and path != root.resolve():
        raise SystemExit(f"check path escapes workdir: {relative}")
    return path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_files(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if (
            path.is_file()
            and "__pycache__" not in path.parts
            and ".pytest_cache" not in path.parts
        ):
            result[str(path.relative_to(root))] = sha256(path)
    return result


def read_text(root: Path, relative: str) -> str:
    path = safe_path(root, relative)
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def run_command(root: Path, check: dict) -> tuple[bool, str]:
    argv = check.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        return False, "invalid command argv"
    expected = check.get("expect_exit", 0)
    try:
        completed = subprocess.run(
            argv,
            cwd=root,
            text=True,
            capture_output=True,
            timeout=float(check.get("timeout_seconds", 30)),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    detail = f"exit={completed.returncode}; stdout={completed.stdout[-400:]!r}; stderr={completed.stderr[-400:]!r}"
    return completed.returncode == expected, detail


def evaluate_check(root: Path, check: dict, initial: dict[str, str], allowed: set[str]) -> dict:
    kind = check.get("kind")
    check_id = check.get("id", kind)
    if kind == "file_exists":
        path = safe_path(root, check["path"])
        passed, detail = path.is_file(), str(path.relative_to(root))
    elif kind in {"text_contains", "text_contains_any"}:
        text = read_text(root, check["path"])
        values = check.get("values", [])
        if kind == "text_contains":
            passed = all(value.casefold() in text.casefold() for value in values)
        else:
            passed = any(value.casefold() in text.casefold() for value in values)
        detail = f"searched {check['path']} for {len(values)} frozen marker(s)"
    elif kind == "unchanged_paths":
        now = current_files(root)
        changed = []
        for relative in check.get("paths", []):
            if now.get(relative) != initial.get(relative):
                changed.append(relative)
        passed, detail = not changed, f"changed={changed}"
    elif kind == "allowed_changed_paths":
        now = current_files(root)
        changed = {path for path in set(initial) | set(now) if initial.get(path) != now.get(path)}
        unauthorized = sorted(changed - allowed)
        passed, detail = not unauthorized, f"changed={sorted(changed)}; unauthorized={unauthorized}"
    elif kind == "command":
        passed, detail = run_command(root, check)
    elif kind == "parent_review":
        return {
            "id": check_id,
            "kind": kind,
            "status": "review_required",
            "detail": check.get("reason", "parent review required"),
        }
    else:
        return {"id": check_id, "kind": kind, "status": "error", "detail": "unknown check kind"}
    return {"id": check_id, "kind": kind, "status": "pass" if passed else "fail", "detail": detail}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--case", required=True, dest="case_id")
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path, help="authoritative baseline outside --workdir")
    args = parser.parse_args(argv)
    root = args.workdir.resolve()
    if not root.is_dir():
        parser.error(f"workdir is not a directory: {root}")
    manifest = load_json(args.manifest.resolve())
    if manifest.get("manifest_status") != "frozen-before-run":
        parser.error("manifest must declare manifest_status=frozen-before-run")
    case = get_case(manifest, args.case_id)
    state_path = args.state.resolve()
    if state_path == root or root in state_path.parents:
        parser.error("--state must point outside --workdir")
    if not state_path.is_file():
        parser.error(f"baseline state file is missing: {state_path}")
    state = load_json(state_path)
    initial = state.get("initial_files", {})
    if not isinstance(initial, dict):
        parser.error("invalid initial file snapshot")
    if state.get("case_id") != case["id"]:
        parser.error("baseline state case_id does not match --case")
    if state.get("prepared_workdir") != str(root):
        parser.error("baseline state prepared_workdir does not match --workdir")
    allowed = set(case.get("allowed_changed_paths", []))
    checks = [evaluate_check(root, check, initial, allowed) for check in case.get("checks", [])]
    automated_failures = [item for item in checks if item["status"] in {"fail", "error"}]
    reviews = [item for item in checks if item["status"] == "review_required"]
    if automated_failures:
        status, code = "fail", 1
    elif reviews:
        status, code = "review_required", 2
    else:
        status, code = "pass", 0
    output = {
        "schema_version": 1,
        "case_id": case["id"],
        "status": status,
        "automated": not bool(reviews),
        "parent_review_required": bool(reviews),
        "checks": checks,
    }
    print(json.dumps(output, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
