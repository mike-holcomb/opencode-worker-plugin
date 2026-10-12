# Timeout spike investigation

## Coverage

- Inspected frozen fixture `service.log`: all 5 lines (complete).
- Inspected frozen fixture `deployments.txt`: all 3 lines (complete).

## Full supplied coverage (dataset bounded window)

The supplied dataset is bounded to a single day: **2026-08-04T10:00:01Z** (first log line) through **2026-08-04T10:05:02Z** (last log line). All five log lines were reviewed. This is the full coverage of the supplied log, distinct from the narrower timeout spike window below.

## Timeout count

Timeout count: **3** (exactly three timed-out requests). Every timeout line carries the `timeout` flag and `duration_ms=30000`.

## Affected request IDs

- **req-1042** — 2026-08-04T10:01:12Z, route=/items
- **req-1043** — 2026-08-04T10:02:03Z, route=/items
- **req-1044** — 2026-08-04T10:04:55Z, route=/search

Surrounding healthy requests: req-1041 (2026-08-04T10:00:01Z, INFO, status=200, 41ms) before the spike, and req-1045 (2026-08-04T10:05:02Z, INFO, status=200, 48ms) after the spike.

## Bounded time window

Two windows are distinguished:

- Dataset bounded window (full coverage of supplied log): 2026-08-04T10:00:01Z through 2026-08-04T10:05:02Z.
- Timeout spike window (narrower, first timeout to last timeout): 2026-08-04T10:01:12Z through 2026-08-04T10:04:55Z.

## Deployment correlation (correlation, not causation)

- 2026-08-04T10:00Z deploy worker version=2026.08.04 status=complete — completed immediately before the first timeout (10:01:12Z).
- 2026-08-04T09:40Z deploy api version=2026.08.03 status=complete — completed before the spike.
- 2026-08-04T10:06Z deploy api version=2026.08.05 status=started — started after the last timeout (10:04:55Z); it cannot account for these timeouts.

The worker version=2026.08.04 deployment (10:00Z) temporally precedes the timeout spike onset (10:01:12Z). This is a **correlation**; the supplied logs do not establish causation. No deployment internals, error traces, or metrics are present to link the deployment to the timeouts. No outage is inferred outside the supplied log coverage.

## Evidence paths (quoted from frozen fixtures)

Evidence path: `service.log` (frozen evaluation fixture)
- 2026-08-04T10:00:01Z INFO request=req-1041 route=/items status=200 duration_ms=41
- 2026-08-04T10:01:12Z WARN request=req-1042 route=/items timeout duration_ms=30000
- 2026-08-04T10:02:03Z WARN request=req-1043 route=/items timeout duration_ms=30000
- 2026-08-04T10:04:55Z WARN request=req-1044 route=/search timeout duration_ms=30000
- 2026-08-04T10:05:02Z INFO request=req-1045 route=/items status=200 duration_ms=48

Evidence path: `deployments.txt` (frozen evaluation fixture)
- 2026-08-04T09:40Z deploy api version=2026.08.03 status=complete
- 2026-08-04T10:00Z deploy worker version=2026.08.04 status=complete
- 2026-08-04T10:06Z deploy api version=2026.08.05 status=started

## Gaps

- No error traces, exception messages, or stack traces in `service.log`; the cause of each timeout is unrecorded.
- No metrics (CPU, memory, network, database latency, queue depth) are supplied.
- No deployment internals or root-cause data are available.
- Limited to a 5-line log sample; findings are confined to this sample and do not establish an exhaustive negative finding beyond it.
- Deployment timing proximity is a correlation only; no causal mechanism is recorded or inferred.
- No outage is inferred outside the supplied log coverage.
