from __future__ import annotations

import importlib.util
import json
import shutil
import signal
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT = Path(__file__).resolve().parents[1]
SKILL = PROJECT / "skills/opencode-agents"


@pytest.fixture
def helper():
    spec = importlib.util.spec_from_file_location(
        "opencode_agent_test", SKILL / "scripts/opencode_agent.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relocated_helper(tmp_path, monkeypatch):
    """Load a copied skill while making its installed bundle read-only."""
    bundle = tmp_path / "installed plugin bundle"
    relocated = bundle / "skills/opencode-agents"
    shutil.copytree(SKILL, relocated, ignore=shutil.ignore_patterns("__pycache__"))
    for path in sorted(bundle.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        path.chmod(0o555 if path.is_dir() else 0o444)
    bundle.chmod(0o555)
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    spec = importlib.util.spec_from_file_location(
        "relocated_opencode_agent_test", relocated / "scripts/opencode_agent.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return bundle, module


@pytest.fixture
def job(tmp_path):
    binary = tmp_path / "fake-opencode"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, os, signal, sys, time\n"
        "from pathlib import Path\n"
        "task = Path(sys.argv[sys.argv.index('--file') + 1]).read_text()\n"
        "Path('invocation.json').write_text(json.dumps({'argv': sys.argv[1:], "
        "'cwd': str(Path.cwd()), 'task': task}))\n"
        "if task == 'sleep': time.sleep(30)\n"
        "if task == 'empty': sys.exit(0)\n"
        "print(json.dumps({'type':'step_start', 'sessionID':'ses_synthetic'}), flush=True)\n"
        "if task == 'error':\n"
        "    print(json.dumps({'type':'error', 'error':'PRIVATE_ERROR'})); sys.exit(0)\n"
        "if task == 'malformed': print('not-json'); sys.exit(0)\n"
        "if task == 'partial': print('{', end=''); sys.exit(0)\n"
        "if task == 'exit7': sys.exit(7)\n"
        "if task == 'signal': os.kill(os.getpid(), signal.SIGTERM)\n"
        "print(json.dumps({'type':'tool_use', 'part':{'state':{'status':'error'}}}))\n"
        "print(json.dumps({'type':'text', 'part':{'text':'PRIVATE_MODEL_OUTPUT'}}))\n"
        "print(json.dumps({'type':'step_finish', 'sessionID':'ses_synthetic', "
        "'part':{'reason':'stop'}}))\n"
    )
    binary.chmod(0o700)
    task = tmp_path / "task.md"
    task.write_text("SYNTHETIC_PRIVATE_TASK")
    out = tmp_path / "job"
    argv = [
        "run", "--task-file", str(task), "--out", str(out), "--cwd", str(tmp_path),
        "--opencode", str(binary), "--model", "synthetic/model",
    ]
    return SimpleNamespace(task=task, out=out, binary=binary, argv=argv, cwd=tmp_path)


def test_preview_does_not_execute_create_directory_or_expose_task(helper, job, capsys):
    assert helper.main(job.argv) == 0
    output = capsys.readouterr().out
    preview = json.loads(output)
    assert preview["state"] == "preview"
    assert "SYNTHETIC_PRIVATE_TASK" not in output
    assert not job.out.exists()
    assert not (job.cwd / "invocation.json").exists()


def test_execution_records_private_artifacts_exact_session_and_model(helper, job, capsys):
    assert helper.main([*job.argv, "--session", "ses_recorded", "--execute"]) == 0
    invocation = json.loads((job.cwd / "invocation.json").read_text())
    assert invocation["task"] == job.task.read_text()
    assert invocation["cwd"] == str(job.cwd)
    command = invocation["argv"]
    assert command[command.index("--session") + 1] == "ses_recorded"
    assert command[command.index("--model") + 1] == "synthetic/model"
    assert command[command.index("--file") + 1] == str(job.out / "task.md")
    assert "SYNTHETIC_PRIVATE_TASK" not in " ".join(command)
    assert {"--pure", "--format"} <= set(command)
    assert not {"--auto", "--continue", "--share", "--attach"} & set(command)
    assert stat.S_IMODE(job.out.stat().st_mode) == 0o700
    assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in job.out.iterdir())
    capsys.readouterr()
    assert helper.main(["status", str(job.out)]) == 0
    output = capsys.readouterr().out
    status = json.loads(output)[0]
    assert status["terminal"] and status["returncode"] == 0
    assert status["session_ids"] == ["ses_synthetic"]
    assert status["tool_errors"] == 1
    assert status["review_required"] is True
    assert "PRIVATE_MODEL_OUTPUT" not in output
    assert "SYNTHETIC_PRIVATE_TASK" not in output


def test_existing_job_is_not_overwritten_or_relaunched(helper, job):
    assert helper.main([*job.argv, "--execute"]) == 0
    saved = {path.name: path.read_bytes() for path in job.out.iterdir()}
    job.task.write_text("changed instructions")
    assert helper.main([*job.argv, "--execute"]) == 2
    assert saved == {path.name: path.read_bytes() for path in job.out.iterdir()}


@pytest.mark.parametrize(
    ("mode", "returncode", "state"),
    [
        ("error", 1, "reported_error"), ("malformed", 1, "reported_error"),
        ("partial", 1, "incomplete_output"), ("empty", 1, "incomplete_output"),
        ("exit7", 7, "exited"), ("signal", 143, "exited"),
        ("sleep", 124, "timed_out"),
    ],
)
def test_failures_are_recorded_without_retry(helper, job, mode, returncode, state):
    job.task.write_text(mode)
    timeout = "0.2" if mode == "sleep" else "10"
    assert helper.main([*job.argv, "--timeout-seconds", timeout, "--execute"]) == returncode
    outcome = json.loads((job.out / "exit.json").read_text())
    assert outcome["state"] == state
    assert outcome["returncode"] == returncode
    assert helper.main(["status", str(job.out)]) == 1


def test_missing_binary_records_failure(helper, job):
    arguments = helper.parse_args([*job.argv, "--execute"])
    arguments.opencode = str(job.cwd / "does-not-exist")
    assert helper.run_job(arguments) == 127
    assert helper.job_status(job.out)["state"] == "launch_or_io_error"


def test_interruption_stops_owned_child_and_records_outcome(helper, job, monkeypatch):
    signals = []

    class Child:
        pid = 123456
        returncode = None
        waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            if self.waits == 1:
                raise KeyboardInterrupt
            self.returncode = -signal.SIGTERM
            return self.returncode

        def poll(self):
            return self.returncode

    monkeypatch.setattr(helper.subprocess, "Popen", lambda *args, **kwargs: Child())
    monkeypatch.setattr(helper, "process_signature", lambda pid: {"state": "unknown"})
    monkeypatch.setattr(helper.os, "killpg", lambda pid, number: signals.append((pid, number)))
    assert helper.main([*job.argv, "--execute"]) == 130
    assert signals == [(123456, signal.SIGTERM)]
    assert helper.job_status(job.out)["state"] == "interrupted"


@pytest.mark.parametrize(
    ("observation", "expected"),
    [
        ({"state": "present", "signature": "original"}, "running"),
        ({"state": "present", "signature": "reused PID"}, "unknown"),
        ({"state": "absent"}, "unknown"), ({"state": "unknown"}, "unknown"),
    ],
)
def test_process_identity_not_pid_or_stop_event_controls_live_status(
    helper, tmp_path, monkeypatch, observation, expected,
):
    helper.write_json(tmp_path / "job.json", {
        "pid": 123456, "process_identity": {"state": "present", "signature": "original"},
    })
    (tmp_path / "events.jsonl").write_text(
        json.dumps({"type": "step_finish", "part": {"reason": "stop"}}) + "\n"
    )
    monkeypatch.setattr(helper, "process_signature", lambda pid: observation)
    status = helper.job_status(tmp_path)
    assert status["state"] == expected
    assert status["terminal"] is False


def test_partial_event_is_not_corruption_or_completion(helper, tmp_path):
    path = tmp_path / "events.jsonl"
    path.write_bytes(b'{"type":"step_start","sessionID":"ses_test"}\n{"type":')
    summary = helper.event_summary(path)
    assert summary["event_count"] == 1 and summary["partial_line"]
    assert summary["malformed_lines"] == 0
    path.write_bytes(path.read_bytes() + b'"text"}\nnot-json\n[]\n')
    summary = helper.event_summary(path)
    assert summary["event_count"] == 2 and not summary["partial_line"]
    assert summary["malformed_lines"] == 2


def test_watch_deadline_never_launches_or_stops_worker(helper, job, monkeypatch):
    monkeypatch.setattr(helper, "job_status", lambda path: {
        "state": "running", "terminal": False,
    })

    def forbidden(*args, **kwargs):
        pytest.fail("monitor must not launch or stop a process")

    monkeypatch.setattr(helper.subprocess, "Popen", forbidden)
    monkeypatch.setattr(helper, "stop_child", forbidden)
    assert helper.main([
        "status", str(job.out), "--watch", "--interval", "0.001", "--wait-seconds", "0.005",
    ]) == 2


def test_multi_job_status_reports_failure_while_other_job_runs(helper, monkeypatch):
    monkeypatch.setattr(helper, "job_status", lambda path: (
        {"state": "exited", "terminal": True, "returncode": 7}
        if path.name == "failed" else {"state": "running", "terminal": False}
    ))
    assert helper.main(["status", "failed", "running"]) == 1


def test_unreadable_job_remains_unknown(helper, tmp_path, monkeypatch):
    def unreadable(path):
        raise PermissionError("synthetic read denial")

    monkeypatch.setattr(helper, "event_summary", unreadable)
    assert helper.job_status(tmp_path)["state"] == "unknown"


@pytest.mark.parametrize(
    ("returncode", "stdout", "stderr", "expected"),
    [(0, "start command\n", "", "present"), (1, "", "", "absent"),
     (1, "", "not permitted", "unknown")],
)
def test_process_probe_distinguishes_absent_from_denied(
    helper, monkeypatch, returncode, stdout, stderr, expected,
):
    monkeypatch.setattr(helper.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        returncode=returncode, stdout=stdout, stderr=stderr,
    ))
    assert helper.process_signature(123456)["state"] == expected


def test_stop_child_escalates_only_its_own_group(helper, monkeypatch):
    signals = []

    class Child:
        pid = 123456

        def poll(self):
            return None

        def wait(self, timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired("synthetic-child", timeout)
            return -signal.SIGKILL

    monkeypatch.setattr(helper.os, "killpg", lambda pid, number: signals.append((pid, number)))
    helper.stop_child(Child())
    assert signals == [(123456, signal.SIGTERM), (123456, signal.SIGKILL)]


def test_missing_job_and_invalid_task_are_safe(helper, job):
    assert helper.main(["status", str(job.out)]) == 2
    job.task.write_text("  \n")
    assert helper.main([*job.argv, "--execute"]) == 2
    assert not job.out.exists()


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf"])
def test_invalid_deadlines_are_rejected(helper, value):
    with pytest.raises(SystemExit):
        helper.parse_args(["status", "unused", "--wait-seconds", value])


def test_relocated_read_only_bundle_runs_in_unrelated_cwd_with_spaces(
    job, tmp_path, monkeypatch,
):
    bundle, relocated = relocated_helper(tmp_path, monkeypatch)
    cwd = tmp_path / "unrelated worker cwd with spaces"
    cwd.mkdir()
    task = tmp_path / "caller task with spaces.md"
    task.write_text("RELOCATED_TASK")
    out = tmp_path / "private output with spaces"
    before = {
        path.relative_to(bundle): (
            path.is_dir(), path.read_bytes() if path.is_file() else None,
        )
        for path in bundle.rglob("*")
    }

    assert relocated.main([
        "run", "--task-file", str(task), "--out", str(out), "--cwd", str(cwd),
        "--opencode", str(job.binary), "--model", "synthetic/model", "--execute",
    ]) == 0

    invocation = json.loads((cwd / "invocation.json").read_text())
    assert invocation["cwd"] == str(cwd.resolve())
    assert invocation["task"] == task.read_text()
    assert (out / "task.md").read_text() == task.read_text()
    assert not (cwd / out.name).exists()
    after = {
        path.relative_to(bundle): (
            path.is_dir(), path.read_bytes() if path.is_file() else None,
        )
        for path in bundle.rglob("*")
    }
    assert after == before


def test_relative_task_and_output_use_caller_directory_not_worker_cwd(
    helper, job, tmp_path, monkeypatch,
):
    caller = tmp_path / "caller directory with spaces"
    worker = tmp_path / "unrelated worker directory with spaces"
    caller.mkdir()
    worker.mkdir()
    task = caller / "relative task packet.md"
    task.write_text("CALLER_RELATIVE_TASK")
    output_name = "relative job output"
    monkeypatch.chdir(caller)

    assert helper.main([
        "run", "--task-file", task.name, "--out", output_name, "--cwd", str(worker),
        "--opencode", str(job.binary), "--model", "synthetic/model", "--execute",
    ]) == 0

    out = caller / output_name
    invocation = json.loads((worker / "invocation.json").read_text())
    command = invocation["argv"]
    assert out.exists()
    assert (out / "task.md").read_text() == task.read_text()
    assert Path(command[command.index("--file") + 1]) == (out / "task.md").resolve()
    assert json.loads((out / "job.json").read_text())["cwd"] == str(worker.resolve())
    assert not (worker / output_name).exists()


def test_historical_job_is_inspectable_after_helper_relocation(
    helper, job, tmp_path, monkeypatch, capsys,
):
    assert helper.main([*job.argv, "--execute"]) == 0
    capsys.readouterr()
    _bundle, relocated = relocated_helper(tmp_path, monkeypatch)

    assert relocated.main(["status", str(job.out)]) == 0
    status = json.loads(capsys.readouterr().out)[0]
    assert status["terminal"] is True
    assert status["returncode"] == 0
    assert status["session_ids"] == ["ses_synthetic"]
    assert status["directory"] == str(job.out.resolve())
