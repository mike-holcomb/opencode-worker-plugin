# Reports, evidence, and parent review

Read the compact state and summary first. A worker report identifies outcome, actual coverage and gaps, findings and caveats, changes, checks run or omitted, blockers, and next action. Negative findings name inspected bounds. A missing or invalid report cannot establish completion.

For code, inspect the entire captured change manifest and relevant diff, including staged changes, new files, deletions, and binary metadata. Compare it with declared writes and the baseline. Rerun or inspect check evidence as needed; reported checks are worker assertions. For research or audits, verify original sources and contrary evidence for adopted claims. Refresh evidence if the live workspace changed after capture.

Record a parent-owned review against the execution and evidence hashes. Mark every required criterion with inspected evidence and explain freshness, gaps, and integration checks. Use `awaiting_evidence` or `needs_correction` when required output is missing. A worker exit, valid report schema, or worker claim is not acceptance. Preserve earlier reports through corrections.

For an `accepted` review, cite each inspected execution artifact as `artifact:<artifact_id>@sha256:<hash>`, using the ID and SHA-256 shown by `opencode_get_task`. Each cited artifact must belong to the reviewed execution. Do not substitute a file path or a worker's unsupported evidence claim for a captured artifact reference.
