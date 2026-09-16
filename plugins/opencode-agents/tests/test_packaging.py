from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


SOURCE_SCRIPT = Path(__file__).resolve().parents[1] / "scripts/build_bundle.py"


def make_fixture(tmp_path: Path) -> Path:
    root = tmp_path / "standalone fixture"
    (root / "scripts").mkdir(parents=True)
    (root / ".codex-plugin").mkdir()
    skill = root / "skills/opencode-agents"
    (skill / "assets").mkdir(parents=True)
    (skill / "references").mkdir()
    shutil.copy2(SOURCE_SCRIPT, root / "scripts/build_bundle.py")
    (root / ".codex-plugin/plugin.json").write_text(
        json.dumps({"name": "fixture", "skills": "./skills/"}) + "\n",
    )
    (skill / "SKILL.md").write_text(
        "# Fixture\n\n[Task](assets/task.md)\n[Operations](references/operations.md)\n",
    )
    (skill / "assets/task.md").write_text("synthetic task\n")
    (skill / "references/operations.md").write_text("synthetic operations\n")
    (skill / "scripts/runtime.py").parent.mkdir()
    (skill / "scripts/runtime.py").write_text("print('synthetic')\n")
    (root / "bundle-files.txt").write_text(
        "\n".join([
            ".codex-plugin/plugin.json",
            "skills/opencode-agents/SKILL.md",
            "skills/opencode-agents/assets/task.md",
            "skills/opencode-agents/references/operations.md",
            "skills/opencode-agents/scripts/runtime.py",
        ]) + "\n",
    )
    return root


def run_builder(root: Path, output: Path | None, *extra: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(root / "scripts/build_bundle.py")]
    if output is not None:
        command.extend(["--out", str(output)])
    command.extend(extra)
    return subprocess.run(
        command,
        cwd=root.parent,
        capture_output=True,
        text=True,
        check=False,
    )


def test_check_is_read_only_and_archive_is_deterministic(tmp_path):
    first_root = make_fixture(tmp_path / "first")
    (first_root / "local-secret.txt").write_text("must stay out\n")
    first_output = tmp_path / "first.zip"
    checked = run_builder(first_root, None, "--check")
    assert checked.returncode == 0, checked.stderr
    assert "Bundle check passed" in checked.stdout

    built = run_builder(first_root, first_output)
    assert built.returncode == 0, built.stderr
    with zipfile.ZipFile(first_output) as archive:
        infos = archive.infolist()
        assert [info.filename for info in infos] == sorted(info.filename for info in infos)
        assert all(info.filename.startswith("opencode-agents/") for info in infos)
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in infos)
        assert all(((info.external_attr >> 16) & 0o777) == 0o644 for info in infos)
        assert "opencode-agents/local-secret.txt" not in archive.namelist()

    second_root = make_fixture(tmp_path / "second")
    second_output = tmp_path / "second.zip"
    second = run_builder(second_root, second_output)
    assert second.returncode == 0, second.stderr
    assert first_output.read_bytes() == second_output.read_bytes()


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda root: (root / "bundle-files.txt").write_text(
            (root / "bundle-files.txt").read_text() + "skills/opencode-agents/SKILL.md\n",
        ), "duplicate"),
        (lambda root: (root / "bundle-files.txt").write_text(
            (root / "bundle-files.txt").read_text() + "../outside.txt\n",
        ), "unsafe"),
        (lambda root: (root / "bundle-files.txt").write_text(
            (root / "bundle-files.txt").read_text() + "skills/opencode-agents\n",
        ), "not a regular file"),
        (lambda root: (root / "bundle-files.txt").write_text(
            (root / "bundle-files.txt").read_text() + "missing.txt\n",
        ), "missing"),
    ],
)
def test_allowlist_rejects_invalid_entries(tmp_path, change, expected):
    root = make_fixture(tmp_path)
    change(root)
    result = run_builder(root, tmp_path / "bundle.zip", "--check")
    assert result.returncode == 2
    assert expected in result.stderr
    assert not (tmp_path / "bundle.zip").exists()


def test_allowlist_rejects_symlink_entry(tmp_path):
    root = make_fixture(tmp_path)
    link = root / "linked.txt"
    link.symlink_to(root / "bundle-files.txt")
    with (root / "bundle-files.txt").open("a") as stream:
        stream.write("linked.txt\n")
    result = run_builder(root, tmp_path / "bundle.zip", "--check")
    assert result.returncode == 2
    assert "symlink" in result.stderr


def test_runtime_files_must_be_allowlisted(tmp_path):
    root = make_fixture(tmp_path)
    extra = root / "skills/opencode-agents/references/unlisted.md"
    extra.write_text("unlisted runtime resource\n")
    result = run_builder(root, tmp_path / "bundle.zip", "--check")
    assert result.returncode == 2
    assert "runtime resource is not listed" in result.stderr


def test_generated_python_cache_is_ignored_but_not_packaged(tmp_path):
    root = make_fixture(tmp_path)
    cache = root / "skills/opencode-agents/scripts/__pycache__"
    cache.mkdir()
    (cache / "runtime.cpython-312.pyc").write_bytes(b"generated")
    output = tmp_path / "bundle.zip"
    result = run_builder(root, output, "--check")
    assert result.returncode == 0, result.stderr
    built = run_builder(root, output)
    assert built.returncode == 0, built.stderr
    with zipfile.ZipFile(output) as archive:
        assert not any("__pycache__" in name or name.endswith(".pyc") for name in archive.namelist())

    unknown = root / "skills/opencode-agents/scripts/cache.pyc"
    unknown.write_bytes(b"not a recognized cache location")
    result = run_builder(root, tmp_path / "unknown.zip", "--check")
    assert result.returncode == 2
    assert "runtime resource is not listed" in result.stderr


def test_markdown_links_must_resolve_to_allowlisted_files(tmp_path):
    root = make_fixture(tmp_path)
    skill = root / "skills/opencode-agents/SKILL.md"
    skill.write_text(skill.read_text() + "[Missing](references/missing.md)\n")
    result = run_builder(root, tmp_path / "bundle.zip", "--check")
    assert result.returncode == 2
    assert "Markdown link" in result.stderr

    root = make_fixture(tmp_path / "listed-target")
    outside = root / "docs/target.md"
    outside.parent.mkdir()
    outside.write_text("target\n")
    skill = root / "skills/opencode-agents/SKILL.md"
    skill.write_text(skill.read_text() + "[Target](../../docs/target.md)\n")
    result = run_builder(root, root.parent / "bundle.zip", "--check")
    assert result.returncode == 2
    assert "not listed" in result.stderr


def test_manifest_must_list_runtime_root_and_manifest_file(tmp_path):
    root = make_fixture(tmp_path)
    manifest = root / ".codex-plugin/plugin.json"
    manifest.write_text(json.dumps({"name": "fixture", "skills": "./missing/"}) + "\n")
    result = run_builder(root, tmp_path / "bundle.zip", "--check")
    assert result.returncode == 2
    assert "skills path" in result.stderr

    root = make_fixture(tmp_path / "unlisted-manifest")
    manifest_line = ".codex-plugin/plugin.json\n"
    (root / "bundle-files.txt").write_text(
        (root / "bundle-files.txt").read_text().replace(manifest_line, ""),
    )
    result = run_builder(root, root.parent / "manifest.zip", "--check")
    assert result.returncode == 2
    assert "manifest is not listed" in result.stderr


def test_existing_output_and_runtime_skill_output_are_rejected(tmp_path):
    root = make_fixture(tmp_path)
    existing = tmp_path / "existing.zip"
    existing.write_bytes(b"already here")
    result = run_builder(root, existing)
    assert result.returncode == 2
    assert "already exists" in result.stderr
    assert existing.read_bytes() == b"already here"

    inside_skills = root / "skills/inside.zip"
    result = run_builder(root, inside_skills)
    assert result.returncode == 2
    assert "inside runtime skills" in result.stderr

    checked = run_builder(root, existing, "--check")
    assert checked.returncode == 0, checked.stderr


def test_destination_race_cannot_clobber_new_file(tmp_path, monkeypatch):
    root = make_fixture(tmp_path)
    spec = importlib.util.spec_from_file_location("fixture_bundle_builder", root / "scripts/build_bundle.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    output = tmp_path / "race.zip"
    real_link = builder.os.link

    def race(temp_name, destination):
        Path(destination).write_bytes(b"created concurrently")
        return real_link(temp_name, destination)

    monkeypatch.setattr(builder.os, "link", race)
    with pytest.raises(builder.BundleError, match="created during build"):
        builder.build(root, output)
    assert output.read_bytes() == b"created concurrently"
    assert not list(tmp_path.glob(".race.zip.*.tmp"))
