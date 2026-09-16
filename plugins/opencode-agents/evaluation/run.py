#!/usr/bin/env python3
"""Run the frozen A/B/C pilot with fresh, sequential Codex parent processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "cases.json"
PARENT_TIMEOUT_SECONDS = 360
WORKER_TIMEOUT_SECONDS = 180
CASE_ID = re.compile(r"^[A-Za-z0-9_.-]+$")


class PilotError(RuntimeError):
    pass


class StopPilot(PilotError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_hashes(path: Path) -> dict[str, str]:
    if path.is_file():
        return {path.name: sha256(path)}
    if not path.is_dir():
        raise PilotError(f"source path is missing: {path}")
    result: dict[str, str] = {}
    for child in sorted(path.rglob("*")):
        if (
            child.is_file()
            and "__pycache__" not in child.parts
            and ".pytest_cache" not in child.parts
        ):
            result[str(child.relative_to(path))] = sha256(child)
    return result


def load_manifest(path: Path) -> dict:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PilotError(f"cannot read manifest {path}: {error}") from error
    if manifest.get("manifest_status") != "frozen-before-run":
        raise PilotError("manifest must declare manifest_status=frozen-before-run")
    cases = manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise PilotError("manifest cases must be a non-empty list")
    return manifest


def select_cases(manifest: dict, requested: list[str] | None) -> list[dict]:
    cases = manifest["cases"]
    by_id = {case.get("id"): case for case in cases}
    if len(by_id) != len(cases):
        raise PilotError("manifest contains duplicate or missing case IDs")
    selected_ids = [case.get("id") for case in cases] if requested is None else requested
    selected: list[dict] = []
    for case_id in selected_ids:
        if not isinstance(case_id, str) or not CASE_ID.fullmatch(case_id):
            raise PilotError(f"unsafe case ID: {case_id!r}")
        if case_id not in by_id:
            raise PilotError(f"unknown case: {case_id}")
        selected.append(by_id[case_id])
    if len({case["id"] for case in selected}) != len(selected):
        raise PilotError("--case may not repeat a case")
    return selected


def require_absolute_file(value: Path, label: str) -> Path:
    if not value.is_absolute() or not value.is_file():
        raise PilotError(f"{label} must be an existing absolute file: {value}")
    return value.resolve()


def require_skill(value: Path, label: str) -> Path:
    if not value.is_absolute() or not value.is_dir():
        raise PilotError(f"{label} must be an existing absolute directory: {value}")
    value = value.resolve()
    for relative in ("scripts/opencode_agent.py", "assets/task-template.md"):
        if not (value / relative).is_file():
            raise PilotError(f"{label} is missing {relative}: {value}")
    return value


def run_prepare(
    manifest: Path,
    case_id: str,
    condition: str,
    run_id: str,
    workdir: Path,
    state: Path,
    record: Path,
) -> dict:
    command = [
        sys.executable,
        str(HERE / "prepare.py"),
        "--manifest", str(manifest),
        "--case", case_id,
        "--condition", condition,
        "--run-id", run_id,
        "--out", str(workdir),
        "--state", str(state),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        write_json(record, {
            "state": "preparation_failed",
            "returncode": completed.returncode,
            "stderr": completed.stderr[-2000:],
        })
        raise PilotError(f"prepare failed for {condition}/{case_id}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PilotError(f"prepare returned invalid JSON for {condition}/{case_id}") from error
    write_json(record, result)
    return result


def copy_private_task(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o600)


def stop_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def json_lines(path: Path) -> list[dict]:
    events: list[dict] = []
    if not path.is_file():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def usage_dict(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens", "cached_input_tokens"):
        if isinstance(value.get(key), int):
            result[key] = value[key]
    return result


def event_metrics(path: Path) -> dict:
    events = json_lines(path)
    usage: dict[str, int] = {}
    turns = 0
    tool_bytes = 0
    tool_events = 0
    tool_types = {"command_execution", "tool_call", "tool_result", "mcp_tool_call", "mcp_tool_result"}
    output_keys = {"aggregated_output", "stdout", "stderr", "tool_output"}
    for event in events:
        if event.get("type") == "turn.completed":
            turns += 1
            candidate = event.get("usage")
            if not isinstance(candidate, dict):
                candidate = event.get("response", {}).get("usage") if isinstance(event.get("response"), dict) else None
            for key, value in usage_dict(candidate).items():
                usage[key] = usage.get(key, 0) + value
        item = event.get("item")
        item_type = item.get("type") if isinstance(item, dict) else None
        if "tool" in str(event.get("type", "")) or item_type in tool_types:
            tool_events += 1
            if isinstance(item, dict):
                for key in output_keys:
                    value = item.get(key)
                    if isinstance(value, str):
                        tool_bytes += len(value.encode("utf-8"))
    return {
        "event_count": len(events),
        "turn_completed": turns,
        "usage": usage,
        "tool_event_count": tool_events,
        "tool_output_utf8_bytes": tool_bytes,
        "note": "UTF-8 byte lengths are context proxies, not token counts; no costs are inferred.",
    }


def worker_metrics(job: Path) -> dict:
    exit_path = job / "exit.json"
    events_path = job / "events.jsonl"
    if not exit_path.is_file():
        return {
            "terminal_child": False,
            "event_path": str(events_path),
            "note": "Worker child has no terminal exit record; worker usage is not summarized.",
        }
    result = event_metrics(events_path)
    last_step_usage: dict[str, object] = {}
    for event in json_lines(events_path):
        if event.get("type") != "step_finish":
            continue
        part = event.get("part")
        if isinstance(part, dict):
            if isinstance(part.get("tokens"), dict):
                last_step_usage["tokens"] = part["tokens"]
            if isinstance(part.get("cost"), (int, float)):
                last_step_usage["cost"] = part["cost"]
    result.update({
        "terminal_child": True,
        "exit_path": str(exit_path),
        "event_path": str(events_path),
        "last_step_usage": last_step_usage,
        "usage_note": "The last step_finish usage is provider-reported session usage; it is not summed across cumulative step events.",
    })
    try:
        result["exit"] = json.loads(exit_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        result["exit"] = {"state": "unreadable"}
    return result


def prompt_for(
    case: dict,
    condition: str,
    phase: str,
    workdir: Path,
    task_packet: Path,
    parent_artifacts: Path,
    job: Path,
    opencode_data: Path,
    skill: Path | None,
    worker_model: str,
    opencode: Path,
) -> str:
    task = workdir / "task.md"
    report = parent_artifacts / "parent-report.md"
    helper_line = ""
    if condition in {"B", "C"}:
        assert skill is not None
        tier_asset = {
            "lightweight": "task-lite.md",
            "standard": "task-template.md",
            "full": "task-full.md",
        }.get(case.get("tier"), "task-template.md")
        template = skill / "assets" / ("task-template.md" if condition == "B" else tier_asset)
        helper_command = (
            f"XDG_DATA_HOME={opencode_data} python3 {skill / 'scripts/opencode_agent.py'} run --task-file {task_packet} "
            f"--out {job} --cwd {workdir} --model {worker_model} "
            f"--opencode {opencode} --timeout-seconds {WORKER_TIMEOUT_SECONDS} --execute"
        )
        if phase == "matched":
            helper_line = (
                "Use only this supplied skill and its task template: " + str(skill) + "\n"
                f"Prepare {task_packet} from the original task using {template} before launch. "
                "Keep the objective and whole-task decomposition unchanged; add the condition's handoff fields without copying hidden checks.\n"
                "Launch its helper exactly once, in the foreground, with this command:\n"
                f"{helper_command}\n"
                "Do not use --continue, --session, retries, another helper, or another endpoint.\n"
            )
        else:
            helper_line = (
                "Use only this supplied skill and its task template when deciding whether to delegate: "
                + str(skill) + "\n"
                f"If you delegate, prepare {task_packet} from the original task using {template}; "
                "keep the objective unchanged and do not copy hidden checks.\n"
                "If you delegate, launch its helper exactly once in the foreground with this command:\n"
                f"{helper_command}\n"
                "If you keep the task local, do not run that command or create a worker job. "
                "Do not use --continue, --session, retries, another helper, or another endpoint.\n"
            )
    else:
        helper_line = "Do the task locally in this fresh parent process; do not launch a worker.\n"
    if phase == "end-to-end" and condition in {"B", "C"}:
        choice = "Decide first whether delegation is worthwhile; record the choice and reason in the parent report."
    elif condition in {"B", "C"}:
        choice = "This matched cell requires one worker for the whole task, using the same decomposition in B and C; record that delegation choice in the parent report."
    else:
        choice = "Record that this is the local-parent A condition."
    skill_rule = (
        "Do not open cases.json, prepare.py, check.py, or any other condition's files or reports.\n"
        if condition == "A" else
        "Do not open cases.json, prepare.py, check.py, the other skill, or any other condition's files or reports.\n"
    )
    return f"""You are the parent for pilot case {case['id']} condition {condition} ({phase}).
Read only {task}, the fixture files in {workdir}, and the supplied condition skill/template when present. {skill_rule}
{helper_line}{choice}
The user authorized this bounded diagnostic pilot using the configured local OpenCode model and endpoint. Do not contact another endpoint, launch grading, commit, publish, or create additional agents.
The prepared case workdir is {workdir}. You may write task deliverables there and may write parent evidence only under {parent_artifacts}.
Keep the worker job private at {job}. The parent acceptance record is separate from worker exit status.
Write a concise but complete parent report to {report}. It must record the decision, objective criteria and evidence inspected, accepted and missed requirements, limitations, delegation choice, and counts of correction, discovery, and verification steps when known. Never invent exact metrics; distinguish unknown counts. Preserve source evidence paths and uncertainty.
Use fresh context. A simulated predecessor in a fixture is not a real session; never invent a session ID. Verify the objective result and full diff/source/check behavior yourself where applicable. Do not run the evaluation checker or alter the frozen manifest.
"""


def launch_parent(
    codex: Path,
    model: str,
    prompt: str,
    workdir: Path,
    parent_artifacts: Path,
    record_path: Path,
    metrics_path: Path,
) -> dict:
    stdout_path = parent_artifacts / "codex.events.jsonl"
    stderr_path = parent_artifacts / "codex.stderr.log"
    command = [
        str(codex), "exec", "--json", "--model", model,
        "--approve-for-me",
        "-c", "sandbox_workspace_write.network_access=true",
        "--skip-git-repo-check", "--add-dir", str(parent_artifacts), prompt,
    ]
    started = utc_now()
    started_monotonic = time.monotonic()
    with open(stdout_path, "wb", opener=lambda path, flags: os.open(path, flags, 0o600)) as stdout:
        with open(stderr_path, "wb", opener=lambda path, flags: os.open(path, flags, 0o600)) as stderr:
            try:
                process = subprocess.Popen(
                    command,
                    cwd=workdir,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
            except OSError as error:
                result = {"state": "launch_failed", "error": str(error), "command": command[:-1]}
                write_json(record_path, result)
                return result
            write_json(record_path, {
                "state": "running",
                "pid": process.pid,
                "started_utc": started,
                "command": command[:-1],
            })
            write_json(parent_artifacts / "active.json", {
                "state": "running",
                "pid": process.pid,
                "started_utc": started,
                "record": str(record_path),
            })
            try:
                returncode = process.wait(timeout=PARENT_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                stop_group(process)
                result = {
                    "state": "timed_out_uncertain",
                    "pid": process.pid,
                    "returncode": 124,
                    "started_utc": started,
                    "finished_utc": utc_now(),
                    "surviving_worker_may_exist": True,
                    "note": "Stopped after the parent wall-time limit; do not resume or restart automatically.",
                }
                write_json(record_path, result)
                write_json(parent_artifacts / "active.json", result)
                raise StopPilot("parent wall-time limit expired")
    result = {
        "state": "completed",
        "pid": process.pid,
        "returncode": returncode,
        "started_utc": started,
        "finished_utc": utc_now(),
        "elapsed_seconds": round(time.monotonic() - started_monotonic, 3),
        "events_path": str(stdout_path),
        "stderr_path": str(stderr_path),
    }
    write_json(record_path, result)
    write_json(parent_artifacts / "active.json", result)
    write_json(metrics_path, {"parent": event_metrics(stdout_path)})
    if returncode != 0 and not json_lines(stdout_path):
        raise PilotError(
            f"Codex exited {returncode} before emitting events; inspect {stderr_path}"
        )
    return result


def prepare_cells(manifest_path: Path, cases: list[dict], run_root: Path, run_id: str) -> list[dict]:
    prepared: list[dict] = []
    for case in cases:
        case_id = case["id"]
        for condition in ("A", "B", "C"):
            cell = run_root / "cells" / case_id / condition
            workdir = cell / "workdir"
            parent_artifacts = run_root / "parent-artifacts" / case_id / condition
            parent_artifacts.mkdir(parents=True, mode=0o700)
            state = parent_artifacts / "initial-state.json"
            prepare_record = cell / "prepare.json"
            result = run_prepare(manifest_path, case_id, condition, run_id, workdir, state, prepare_record)
            task_packet = parent_artifacts / "task.md"
            copy_private_task(workdir / "task.md", task_packet)
            job = parent_artifacts / "worker-job"
            opencode_data = parent_artifacts / "opencode-data"
            opencode_data.mkdir(mode=0o700)
            prepared.append({
                "case_id": case_id,
                "condition": condition,
                "case": case,
                "workdir": workdir,
                "state": state,
                "parent_artifacts": parent_artifacts,
                "task_packet": task_packet,
                "job": job,
                "opencode_data": opencode_data,
                "prepare": result,
            })
    return prepared


def snapshot_skill(source: Path, destination: Path) -> Path:
    """Copy a frozen skill into a parent-writable cell directory."""
    if destination.exists():
        raise PilotError(f"refusing existing skill snapshot: {destination}")
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.pyc"),
    )
    return destination


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="absolute new private run root")
    parser.add_argument("--codex", required=True, type=Path, help="absolute Codex CLI")
    parser.add_argument("--baseline-skill", required=True, type=Path)
    parser.add_argument("--proposed-skill", required=True, type=Path)
    parser.add_argument("--parent-model", default="gpt-5.6-luna")
    parser.add_argument("--worker-model", required=True)
    parser.add_argument("--opencode", required=True, type=Path)
    parser.add_argument("--endpoint", required=True, help="recorded endpoint label")
    parser.add_argument("--case", action="append", dest="cases")
    parser.add_argument("--phase", choices=("matched", "end-to-end"), default="matched")
    args = parser.parse_args(argv)
    try:
        out = args.out
        if not out.is_absolute() or out.exists():
            raise PilotError(f"--out must be an absolute new path: {out}")
        codex = require_absolute_file(args.codex, "--codex")
        opencode = require_absolute_file(args.opencode, "--opencode")
        baseline = require_skill(args.baseline_skill, "--baseline-skill")
        proposed = require_skill(args.proposed_skill, "--proposed-skill")
        manifest_path = DEFAULT_MANIFEST.resolve()
        manifest = load_manifest(manifest_path)
        cases = select_cases(manifest, args.cases)
        out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        out.mkdir(mode=0o700, parents=False)
        run_id = out.name
        shutil.copyfile(manifest_path, out / "cases.json")
        (out / "cases.json").chmod(0o600)
        config = {
            "schema_version": 1,
            "run_id": run_id,
            "created_utc": utc_now(),
            "phase": args.phase,
            "endpoint_label": args.endpoint,
            "parent_model": args.parent_model,
            "worker_model": args.worker_model,
            "codex": str(codex),
            "opencode": str(opencode),
            "baseline_skill": str(baseline),
            "proposed_skill": str(proposed),
            "cases": [case["id"] for case in cases],
            "parent_timeout_seconds": PARENT_TIMEOUT_SECONDS,
            "worker_timeout_seconds": WORKER_TIMEOUT_SECONDS,
            "source_hashes": {
                "manifest": sha256(manifest_path),
                "run.py": sha256(HERE / "run.py"),
                "prepare.py": sha256(HERE / "prepare.py"),
                "check.py": sha256(HERE / "check.py"),
                "baseline_skill": source_hashes(baseline),
                "proposed_skill": source_hashes(proposed),
                "codex": sha256(codex),
                "opencode": sha256(opencode),
            },
            "metrics_note": "Usage is parsed from turn.completed where available. UTF-8 byte lengths are context proxies, not token counts; no costs are inferred.",
        }
        write_json(out / "run-config.json", config)
        status = {"state": "preparing", "run_id": run_id, "updated_utc": utc_now()}
        write_json(out / "run-status.json", status)
        cells = prepare_cells(manifest_path, cases, out, run_id)
        final_cells: list[dict] = []
        for cell in cells:
            case_id, condition = cell["case_id"], cell["condition"]
            skill = None
            if condition in {"B", "C"}:
                source_skill = baseline if condition == "B" else proposed
                skill = snapshot_skill(
                    source_skill,
                    cell["parent_artifacts"] / ("baseline-skill" if condition == "B" else "proposed-skill"),
                )
            parent_record = cell["parent_artifacts"] / "parent.json"
            metrics_path = cell["parent_artifacts"] / "metrics.json"
            prompt = prompt_for(
                cell["case"], condition, args.phase, cell["workdir"], cell["task_packet"],
                cell["parent_artifacts"], cell["job"], cell["opencode_data"], skill,
                args.worker_model, opencode,
            )
            write_json(cell["parent_artifacts"] / "launch.json", {
                "case_id": case_id, "condition": condition, "parent_model": args.parent_model,
                "phase": args.phase, "worker_model": args.worker_model if condition != "A" else None,
                "endpoint_label": args.endpoint, "task_path": str(cell["task_packet"]),
                "job_path": str(cell["job"]), "parent_report": str(cell["parent_artifacts"] / "parent-report.md"),
            })
            print(f"cell started: {condition}/{case_id}", flush=True)
            status.update({"state": "running", "cell": f"{condition}/{case_id}", "updated_utc": utc_now()})
            write_json(out / "run-status.json", status)
            try:
                parent_result = launch_parent(
                    codex, args.parent_model, prompt, cell["workdir"], cell["parent_artifacts"],
                    parent_record, metrics_path,
                )
            except StopPilot:
                final_cells.append({"case_id": case_id, "condition": condition, "state": "timed_out_uncertain"})
                raise
            metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.is_file() else {}
            summary_path = cell["workdir"] / cell["case"].get("result", "summary.md")
            parent_report_path = cell["parent_artifacts"] / "parent-report.md"
            metrics["context_proxies"] = {
                "launch_prompt_utf8_bytes": len(prompt.encode("utf-8")),
                "handoff_utf8_bytes": cell["task_packet"].stat().st_size,
                "worker_summary_utf8_bytes": summary_path.stat().st_size if summary_path.is_file() else None,
                "parent_report_utf8_bytes": parent_report_path.stat().st_size if parent_report_path.is_file() else None,
                "note": "Byte counts are separately attributed proxies, not tokens or billed input.",
            }
            if condition != "A":
                metrics["worker"] = worker_metrics(cell["job"])
                write_json(metrics_path, metrics)
            final = {
                "case_id": case_id,
                "condition": condition,
                "state": (
                    parent_result["state"]
                    if (cell["parent_artifacts"] / "parent-report.md").is_file()
                    else "completed_missing_parent_report"
                ),
                "returncode": parent_result.get("returncode"),
                "parent_report": str(cell["parent_artifacts"] / "parent-report.md"),
                "parent_report_present": (cell["parent_artifacts"] / "parent-report.md").is_file(),
                "acceptance_status": (
                    "recorded_for_parent_review"
                    if (cell["parent_artifacts"] / "parent-report.md").is_file()
                    else "unmet_missing_parent_report"
                ),
                "metrics": str(metrics_path),
                "worker_job": str(cell["job"]) if condition != "A" else None,
                "delegation_mode": (
                    "local" if condition == "A" else
                    "required_worker" if args.phase == "matched" else "parent_decision"
                ),
            }
            final_cells.append(final)
            print(f"cell finished: {condition}/{case_id} state={final['state']} returncode={final.get('returncode')}", flush=True)
        status.update({"state": "finished", "updated_utc": utc_now()})
        write_json(out / "run-status.json", status)
        report = {
            "schema_version": 1,
            "run_id": run_id,
            "state": "finished",
            "phase": args.phase,
            "endpoint_label": args.endpoint,
            "decision": "Parent acceptance decisions are recorded in each private parent-report.md and remain pending independent review.",
            "counts": {
                "correction_steps": "reported by parent cells when known",
                "discovery_steps": "reported by parent cells when known",
                "verification_steps": "reported by parent cells when known",
            },
            "cells": final_cells,
            "limitations": [
                "Parent reports and objective acceptance remain for independent review.",
                "No evaluation checker was run automatically.",
                "UTF-8 byte lengths are context proxies, not token counts; no costs are inferred.",
            ],
        }
        write_json(out / "final-report.json", report)
        return 0
    except StopPilot as error:
        if args.out.is_absolute() and args.out.is_dir():
            report = {"schema_version": 1, "state": "stopped_timeout_uncertain", "error": str(error)}
            write_json(args.out / "final-report.json", report)
            write_json(args.out / "run-status.json", {
                "state": "stopped_timeout_uncertain", "updated_utc": utc_now(),
                "note": "Do not resume or restart while any worker may survive.",
            })
        print(f"Error: {error}", file=sys.stderr)
        return 124
    except (PilotError, OSError) as error:
        if args.out.is_absolute() and args.out.is_dir():
            write_json(args.out / "final-report.json", {
                "schema_version": 1,
                "state": "stopped_error",
                "error": str(error),
                "note": "No automatic retry was attempted; inspect run-status and the current cell records.",
            })
            write_json(args.out / "run-status.json", {
                "state": "stopped_error",
                "updated_utc": utc_now(),
                "error": str(error),
            })
        print(f"Error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
