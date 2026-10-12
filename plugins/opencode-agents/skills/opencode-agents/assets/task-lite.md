# Lightweight v2 task packet

Use `tier: "lightweight"` for one focused lookup, check, or small change. Fill every required typed packet field even when its array is empty: `title`, `objective`, `authoritative_inputs`, `context`, `allowed_writes`, `acceptance_criteria`, `checks`, `constraints`, `stop_conditions`, and `shared_resources`.

Name the exact source and deliverable, observable completion and evidence, project guidance, authorization constraints, starting revision and relevant dirty state, and a concrete stop condition. Use an empty `allowed_writes` array for a read-only task. The supervisor supplies report paths; do not add them as project writes. Return actual coverage, gaps, check results, and evidence, including a bounded no-finding statement when appropriate. The parent reviews separately.
