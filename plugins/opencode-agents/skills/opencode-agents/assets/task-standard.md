# Standard v2 task packet

Supply this content through the typed `packet` fields of `opencode_start_task` or `opencode_continue_task`, not as an opaque task file.

- `title`, `objective`, `tier: "standard"`: one bounded deliverable.
- `authoritative_inputs`: original files, artifacts, URLs, or inline facts, each with purpose and expected hash when known.
- `context`: verified facts, rejected assumptions, exclusions, and predecessor task ID if applicable.
- `allowed_writes`: intended project files or directories and purposes. The supervisor assigns report paths.
- `acceptance_criteria`: stable IDs, observable requirements, required evidence, and required flags.
- `checks`: IDs, descriptions, and optional argv/cwd for checks the worker may run.
- `constraints`, `stop_conditions`, `shared_resources`: policy limits, concrete stop triggers, and read/write resource keys.

Set launch fields separately: workspace, configured model, profile, limits, scope, and idempotency key. For mutable inputs include revision, relevant dirty state, dependencies, and freshness check in the packet context. Allowed writes are audited task boundaries, not an OS sandbox.
