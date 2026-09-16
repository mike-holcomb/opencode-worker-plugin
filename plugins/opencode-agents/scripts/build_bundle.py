"""Build a deterministic, allowlisted ZIP bundle for the opencode-agents plugin."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit


ARCHIVE_PREFIX = "opencode-agents/"
ALLOWLIST_NAME = "bundle-files.txt"
MANIFEST_NAME = ".codex-plugin/plugin.json"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)")


class BundleError(ValueError):
    """An input or packaging policy violation."""


def _allowlist_path(raw: str, line_number: int) -> str:
    value = raw.strip()
    if not value:
        raise BundleError(f"bundle-files.txt:{line_number}: empty path")
    if "\x00" in value or "\\" in value:
        raise BundleError(f"bundle-files.txt:{line_number}: unsafe path {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise BundleError(f"bundle-files.txt:{line_number}: unsafe path {value!r}")
    normalized = path.as_posix()
    if normalized != value:
        raise BundleError(f"bundle-files.txt:{line_number}: non-canonical path {value!r}")
    return normalized


def _is_generated_cache(relative: str) -> bool:
    parts = PurePosixPath(relative).parts
    return len(parts) >= 2 and parts[-2] == "__pycache__" and parts[-1].endswith(".pyc")


def _local_reference(raw: str, description: str) -> str:
    value = raw.strip()
    if "\x00" in value or "\\" in value:
        raise BundleError(f"{description}: unsafe path {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        raise BundleError(f"{description}: unsafe path {value!r}")
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts:
        raise BundleError(f"{description}: empty path")
    return "/".join(parts)


def _checked_path(root: Path, relative: str, description: str) -> Path:
    """Resolve a relative path while rejecting symlink components."""
    current = root
    for component in PurePosixPath(relative).parts:
        current /= component
        if current.is_symlink():
            raise BundleError(f"{description}: symlink is not allowed: {relative}")
    return current


def _read_allowlist(root: Path) -> dict[str, Path]:
    allowlist = _checked_path(root, ALLOWLIST_NAME, "allowlist")
    if not allowlist.is_file():
        raise BundleError(f"missing allowlist: {allowlist}")
    entries: dict[str, Path] = {}
    try:
        lines = allowlist.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise BundleError(f"cannot read allowlist: {error}") from error
    for line_number, line in enumerate(lines, 1):
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        relative = _allowlist_path(value, line_number)
        if relative in entries:
            raise BundleError(f"bundle-files.txt:{line_number}: duplicate path {relative!r}")
        if _is_generated_cache(relative):
            raise BundleError(f"generated Python cache must not be listed: {relative}")
        path = _checked_path(root, relative, f"allowlist entry {relative!r}")
        if not path.exists():
            raise BundleError(f"allowlist entry is missing: {relative}")
        if not path.is_file():
            raise BundleError(f"allowlist entry is not a regular file: {relative}")
        entries[relative] = path
    return entries


def _manifest_skills(root: Path, entries: dict[str, Path]) -> list[str]:
    if MANIFEST_NAME not in entries:
        raise BundleError(f"manifest is not listed in bundle-files.txt: {MANIFEST_NAME}")
    manifest = entries[MANIFEST_NAME]
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BundleError(f"invalid plugin manifest: {error}") from error
    if not isinstance(document, dict):
        raise BundleError("plugin manifest must contain a JSON object")
    declared = document.get("skills")
    if isinstance(declared, str):
        declared_paths = [declared]
    elif isinstance(declared, list) and all(isinstance(item, str) for item in declared):
        declared_paths = declared
    else:
        raise BundleError("plugin manifest skills must be a path or list of paths")
    skill_roots: list[str] = []
    for item in declared_paths:
        relative = _local_reference(item, "plugin manifest skills path")
        path = _checked_path(root, relative, "plugin manifest skills path")
        if not path.is_dir():
            raise BundleError(f"plugin manifest skills path is not a directory: {relative}")
        skill_roots.append(relative)
    return skill_roots


def _runtime_completeness(root: Path, entries: dict[str, Path], skill_roots: list[str]) -> None:
    listed = set(entries)
    for relative_root in skill_roots:
        root_path = _checked_path(root, relative_root, "runtime skills")
        for path in sorted(root_path.rglob("*")):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                raise BundleError(f"runtime resource is a symlink: {relative}")
            if path.is_dir() and path.name == "__pycache__":
                continue
            if path.is_file() and _is_generated_cache(relative):
                continue
            if path.is_file() and relative not in listed:
                raise BundleError(f"runtime resource is not listed: {relative}")
            if not path.is_file() and not path.is_dir():
                raise BundleError(f"runtime resource is not a regular file or directory: {relative}")


def _link_path(source: str, target: str) -> str:
    target = unquote(target)
    if "\x00" in target or "\\" in target:
        raise BundleError(f"unsafe local Markdown link in {source}: {target!r}")
    target_path = PurePosixPath(target)
    if target_path.is_absolute():
        raise BundleError(f"unsafe local Markdown link in {source}: {target!r}")
    components = list(PurePosixPath(source).parent.parts)
    for component in target_path.parts:
        if component in ("", "."):
            continue
        if component == "..":
            if not components:
                raise BundleError(f"local Markdown link escapes bundle in {source}: {target!r}")
            components.pop()
        else:
            components.append(component)
    if not components:
        raise BundleError(f"empty local Markdown link in {source}")
    return "/".join(components)


def _validate_markdown_links(root: Path, entries: dict[str, Path]) -> None:
    listed = set(entries)
    for source, path in sorted(entries.items()):
        if path.suffix.lower() != ".md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise BundleError(f"cannot read Markdown file {source}: {error}") from error
        for match in MARKDOWN_LINK.finditer(text):
            raw_target = match.group(1).strip()
            if raw_target.startswith("<"):
                closing = raw_target.find(">")
                target = raw_target[1:closing] if closing > 0 else raw_target
            else:
                target = raw_target.split(None, 1)[0]
            parsed = urlsplit(target)
            if target.startswith("#") or parsed.scheme or parsed.netloc:
                continue
            if not parsed.path:
                continue
            relative = _link_path(source, parsed.path)
            target_path = _checked_path(root, relative, f"Markdown link from {source}")
            if not target_path.is_file():
                raise BundleError(f"Markdown link target is not a file: {source} -> {relative}")
            if relative not in listed:
                raise BundleError(f"Markdown link target is not listed: {source} -> {relative}")


def validate_bundle(root: Path) -> dict[str, Path]:
    root = root.resolve()
    if not root.is_dir():
        raise BundleError(f"bundle root is not a directory: {root}")
    entries = _read_allowlist(root)
    skill_roots = _manifest_skills(root, entries)
    _runtime_completeness(root, entries, skill_roots)
    _validate_markdown_links(root, entries)
    return entries


def _validate_output(root: Path, output: Path) -> Path:
    if not output.is_absolute():
        raise BundleError("--out must be an absolute path")
    resolved = output.resolve()
    if resolved.exists():
        raise BundleError(f"output already exists: {resolved}")
    skills_root = (root / "skills").resolve()
    if resolved == skills_root or skills_root in resolved.parents:
        raise BundleError("output cannot be inside runtime skills")
    return resolved


def write_bundle(root: Path, output: Path, entries: dict[str, Path]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=output.parent, prefix=f".{output.name}.", suffix=".tmp", delete=False,
        ) as temporary:
            temporary_name = temporary.name
        with zipfile.ZipFile(
            temporary_name, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9,
        ) as archive:
            for relative, path in sorted(entries.items()):
                info = zipfile.ZipInfo(ARCHIVE_PREFIX + relative, FIXED_TIMESTAMP)
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
        try:
            os.link(temporary_name, output)
        except FileExistsError as error:
            raise BundleError(f"output was created during build: {output}") from error
        os.unlink(temporary_name)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def build(root: Path, output: Path | None, check: bool = False) -> int:
    entries = validate_bundle(root)
    if check:
        print(f"Bundle check passed: {len(entries)} files")
        return 0
    if output is None:
        raise BundleError("--out is required when building an archive")
    resolved_output = _validate_output(root, output)
    write_bundle(root, resolved_output, entries)
    print(f"Wrote {resolved_output} ({len(entries)} files)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="absolute output ZIP path")
    parser.add_argument("--check", action="store_true", help="validate without writing a ZIP")
    arguments = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    try:
        return build(root, arguments.out, arguments.check)
    except (BundleError, OSError, UnicodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
