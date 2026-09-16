"""Preview, execute, and observe bounded OpenCode jobs without automatic retries."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def write_json(path: Path, value: dict) -> None:
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def private_file(path: Path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def process_signature(pid: int) -> dict:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
            capture_output=True, text=True, timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"state": "unknown"}
    if result.returncode == 0 and result.stdout.strip():
        return {"state": "present", "signature": result.stdout.strip()}
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return {"state": "absent"}
    return {"state": "unknown"}


def event_summary(path: Path) -> dict:
    summary = {
        "event_count": 0, "session_ids": [], "last_event_type": None,
        "last_finish_reason": None, "reported_errors": 0, "tool_errors": 0,
        "malformed_lines": 0, "partial_line": False,
        "last_event_timestamp": None, "seconds_since_log_update": None,
    }
    if not path.exists():
        return summary
    with path.open("rb") as stream:
        for line in stream:
            if not line.endswith(b"\n"):
                summary["partial_line"] = True
                continue
            try:
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError("event is not an object")
            except (ValueError, UnicodeError):
                summary["malformed_lines"] += 1
                continue
            summary["event_count"] += 1
            summary["last_event_type"] = event.get("type")
            summary["last_event_timestamp"] = event.get("timestamp")
            part = event.get("part")
            part = part if isinstance(part, dict) else {}
            session_id = event.get("sessionID") or part.get("sessionID")
            if isinstance(session_id, str) and session_id not in summary["session_ids"]:
                summary["session_ids"].append(session_id)
            summary["reported_errors"] += event.get("type") == "error"
            state = part.get("state")
            if isinstance(state, dict) and state.get("status") == "error":
                summary["tool_errors"] += 1
            if event.get("type") == "step_finish":
                summary["last_finish_reason"] = part.get("reason")
    summary["seconds_since_log_update"] = round(max(0, time.time() - path.stat().st_mtime), 3)
    return summary


def job_status(directory: Path) -> dict:
    directory = directory.resolve()
    result = {"directory": str(directory), "state": "unknown", "terminal": False}
    try:
        events = event_summary(directory / "events.jsonl")
        result.update(events)
        job = json.loads((directory / "job.json").read_text())
        if (directory / "exit.json").exists():
            result.update(json.loads((directory / "exit.json").read_text()))
            result.update(events)
            result["terminal"] = True
            return result
        pid = job.get("pid")
        observed = process_signature(pid) if isinstance(pid, int) else {"state": "unknown"}
        result["pid"] = pid
        result["process_observation"] = observed["state"]
        if observed.get("signature") and observed == job.get("process_identity"):
            result["state"] = "running"
    except (OSError, ValueError, TypeError, AttributeError):
        result["state"] = "unknown"
    return result


def stop_child(child: subprocess.Popen) -> None:
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()


def interrupt(signum, frame) -> None:
    raise KeyboardInterrupt


def run_job(arguments: argparse.Namespace) -> int:
    directory = arguments.out.resolve()
    cwd = arguments.cwd.resolve()
    task = arguments.task_file.read_bytes()
    if not task.decode("utf-8").strip():
        raise ValueError("task file must contain UTF-8 instructions")
    if not cwd.is_dir():
        raise ValueError("working directory does not exist")
    if directory.exists():
        raise FileExistsError(f"refusing existing job directory: {directory}")
    binary = arguments.opencode or shutil.which("opencode") or str(
        Path.home() / ".opencode/bin/opencode"
    )
    binary = shutil.which(binary) or str(Path(binary).expanduser().resolve())
    command = [
        binary, "run", "Execute the instructions in the attached task file.",
        "--pure", "--format", "json", "--model", arguments.model,
        "--agent", arguments.agent, "--title", arguments.title,
    ]
    if arguments.session:
        command.extend(["--session", arguments.session])
    command.extend(["--file", str(directory / "task.md")])
    job = {
        "schema_version": 1, "created_utc": utc_now(), "cwd": str(cwd),
        "command": command, "task_sha256": hashlib.sha256(task).hexdigest(),
        "timeout_seconds": arguments.timeout_seconds,
    }
    if not arguments.execute:
        print(json.dumps({"state": "preview", "directory": str(directory), **job}, indent=2))
        return 0
    if os.name != "posix":
        raise ValueError("execution requires POSIX process-group support")
    directory.mkdir(parents=True, mode=0o700)
    with private_file(directory / "task.md") as stream:
        stream.write(task)
    write_json(directory / "job.json", job)
    child = None
    previous_handler = signal.signal(signal.SIGTERM, interrupt)
    started = time.monotonic()
    state, returncode = "exited", 0
    try:
        with private_file(directory / "events.jsonl") as stdout:
            with private_file(directory / "stderr.log") as stderr:
                child = subprocess.Popen(
                    command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    start_new_session=True,
                )
                job.update(pid=child.pid, process_identity=process_signature(child.pid))
                write_json(directory / "job.json", job)
                print(json.dumps({"state": "started", "directory": str(directory),
                                  "pid": child.pid}), flush=True)
                returncode = child.wait(timeout=arguments.timeout_seconds)
    except subprocess.TimeoutExpired:
        state, returncode = "timed_out", 124
    except KeyboardInterrupt:
        state, returncode = "interrupted", 130
    except OSError:
        state, returncode = "launch_or_io_error", 127
    finally:
        if child is not None:
            stop_child(child)
        signal.signal(signal.SIGTERM, previous_handler)
    summary = event_summary(directory / "events.jsonl")
    if returncode == 0 and (summary["reported_errors"] or summary["malformed_lines"]):
        state, returncode = "reported_error", 1
    if returncode == 0 and (not summary["event_count"] or summary["partial_line"]):
        state, returncode = "incomplete_output", 1
    if returncode < 0:
        returncode = 128 - returncode
    outcome = {
        "schema_version": 1, "state": state, "returncode": returncode,
        "child_returncode": child.returncode if child else None,
        "finished_utc": utc_now(), "elapsed_seconds": round(time.monotonic() - started, 3),
        "review_required": True, **summary,
    }
    write_json(directory / "exit.json", outcome)
    print(json.dumps({"directory": str(directory), **outcome}, indent=2))
    return returncode


def monitor(arguments: argparse.Namespace) -> int:
    deadline = time.monotonic() + arguments.wait_seconds
    while True:
        statuses = [job_status(directory) for directory in arguments.jobs]
        print(json.dumps(statuses, indent=None if arguments.watch else 2), flush=True)
        if all(status["terminal"] for status in statuses):
            return int(any(status.get("returncode") != 0 for status in statuses))
        if not arguments.watch:
            if any(status["terminal"] and status.get("returncode") != 0 for status in statuses):
                return 1
            return 2 if any(status["state"] == "unknown" for status in statuses) else 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 2
        time.sleep(min(arguments.interval, remaining))


def positive_seconds(value: str) -> float:
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("seconds must be finite and positive")
    return seconds


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="preview a job; launch only with --execute")
    run.add_argument("--task-file", required=True, type=Path)
    run.add_argument("--out", required=True, type=Path)
    run.add_argument("--cwd", type=Path, default=Path.cwd())
    run.add_argument("--model", required=True)
    run.add_argument("--agent", default="build")
    run.add_argument("--title", default="Delegated task")
    run.add_argument("--opencode")
    run.add_argument("--session")
    run.add_argument("--timeout-seconds", type=positive_seconds, default=1800)
    run.add_argument("--execute", action="store_true")
    status = commands.add_parser("status", help="observe jobs without model calls or retries")
    status.add_argument("jobs", nargs="+", type=Path)
    status.add_argument("--watch", action="store_true")
    status.add_argument("--interval", type=positive_seconds, default=5)
    status.add_argument("--wait-seconds", type=positive_seconds, default=120)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = parse_args(argv)
        return run_job(arguments) if arguments.command == "run" else monitor(arguments)
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
