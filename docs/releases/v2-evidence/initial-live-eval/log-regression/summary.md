# Timeout spike investigation

## Outcome

Read-only investigation of the frozen evaluation fixtures `service.log` and `deployments.txt`. The timeout spike is bounded to a single time window; the affected request IDs, timeout count, and deployment correlation are listed below with quoted evidence paths. Causation is not claimed.

## Timeout count and affected requests

- Timeout count: **3** (exactly three timed-out requests).
- Affected request IDs: **req-1042**, **req-1043**, **req-1044**.
- All three timeouts carry the `timeout` flag and `duration_ms=30000`. req-1042 and req-1043 are on `route=/items`; req-1044 is on `route=/search`.
- Surrounding healthy requests: req-1041 (INFO, status=200, 41ms) before the spike, and req-1045 (INFO, status=200, 48ms) after the spike.

## Bounded time window

The timeout spike spans **2026-08-04T10:01:12Z** through **2026-08-04T10:04:55Z** (first timeout at 10:01:12Z; last timeout at 10:04:55Z). This window is the bounded interval during which timeouts occur in `service.log`.

## Deployment correlation (correlation, not causation)

- `2026-08-04T10:00Z deploy worker version=2026.08.04 status=complete` — the worker deployment completed immediately before the first timeout at 10:01:12Z.
- `2026-08-04T09:40Z deploy api version=2026.08.03 status=complete` — completed prior to the spike.
- `2026-08-04T10:06Z deploy api version=2026.08.05 status=started` — started after the last timeout at 10:04:55Z, so it cannot account for these timeouts.

The worker version=2026.08.04 deployment at 10:00Z temporally precedes the onset of the timeout spike at 10:01:12Z. This is a **correlation**; the supplied logs do not establish causation.

## Evidence paths (quoted from frozen fixtures)

Evidence path: `service.log` (frozen evaluation fixture)
- Line 2: `2026-08-04T10:01:12Z WARN request=req-1042 route=/items timeout duration_ms=30000`
- Line 3: `2026-08-04T10:02:03Z WARN request=req-1043 route=/items timeout duration_ms=30000`
- Line 4: `2026-08-04T10:04:55Z WARN request=req-1044 route=/search timeout duration_ms=30000`

Evidence path: `deployments.txt` (frozen evaluation fixture)
- Line 2: `2026-08-04T10:00Z deploy worker version=2026.08.04 status=complete`

## Gaps

- No error traces, exception messages, or stack traces are present in `service.log`, so the cause of each timeout is unrecorded.
- No metrics are supplied (CPU, memory, network, database latency, queue depth).
- No deployment internals or root-cause data are available.
- Only a 5-line log sample and 3 deployment events are supplied; findings are confined to this sample and do not establish an exhaustive negative finding beyond it.
- Deployment timing proximity is only a correlation; no causal mechanism is recorded or inferred.
