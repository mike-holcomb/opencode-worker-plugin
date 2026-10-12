# Release evidence, 2026-10-12

The authoritative gate status is [ledger.json](ledger.json). This directory keeps
portable observations and immutable report exports. Private SQLite state,
transport credentials, provider configuration, and HOME/XDG directories are not
published. Local recovery state remains in the isolated campaign directories.

- `ci-38291901986`: clean commit `ceb4c27`, Ubuntu 24.04 x64 and macOS 15 arm64,
  minimum/current supported Node 24; complete runner output and CI job links.
- `macos-local-*`: the same committed platform runner on the local macOS host.
- `initial-live-eval`: actual T20 and live 6/7/9 attempts plus the first twelve
  evaluation attempts, including every failure and explicit parent decision.
- `lookup-correction`, `log-correction`: same-session corrections with new
  execution/message IDs; failed predecessors remain in `initial-live-eval`.
- `eval-rerun`, `live-final`: later attempts; a terminal task or passing frozen
  marker checks alone does not mean accepted. Inspect `decision.json`/`review.json`.
- `upgrade-rollback`: drained old/new runtime rehearsal and matching backup restore.
- `historical-tag-smoke`: installation of the historical pushed development tag;
  this does not certify the changed candidate tag.
- `failed-resource-fixture`, `repaired-short-fixture`: retained lifecycle failure
  and short diagnostic rerun. Neither substitutes for the required hour-long soak.
- `failed-macos-startup-race`: retained platform failure that exposed the losing
  supervisor's socket cleanup race, fixed before the clean CI campaign.

Report artifacts retain their original bytes and SHA-256 identities. Context-byte
measurements describe the recorded review input, not estimated tokens. Review
elapsed time is wall time and can include other parent work. Token sidecars are
correlated to the exact OpenCode session/user message; missing counters and
unverified billing cost stay null. Rejected infrastructure and harness attempts
remain in the denominator of attempt reporting, distinguished from model-quality
failures. The final summary must not claim all twelve scenarios passed until
each intended outcome has received an explicit parent review.
