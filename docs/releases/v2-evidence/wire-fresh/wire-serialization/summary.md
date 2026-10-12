# Wire-Format v2 Coupling — Worker Report

## Interface decision (producer <-> consumer)

Both modules share a module-level `ENVELOPE_VERSION = 2` constant that binds the v2 contract:

- Envelope shape: `{"version": 2, "request": {"id": <request_id>, "body": <payload>}}`
- `producer.encode(request_id, payload)` serializes the envelope to a JSON string.
- `consumer.decode(raw)` parses the JSON, rejects any envelope whose `version` is missing or != 2 with `ValueError("missing version")`, and returns `(request_id, body)`.
- The request identifier is carried verbatim at `request.id` by the producer and returned unchanged as the first element of `decode`'s result by the consumer, so it is stable across the round trip.

## Changed paths

- `producer.py` — introduced `ENVELOPE_VERSION = 2`; `encode` writes `"version": ENVELOPE_VERSION`.
- `consumer.py` — introduced `ENVELOPE_VERSION = 2`; `decode` validates `message.get("version") != ENVELOPE_VERSION` (rejects missing and non-v2).

No other source paths were modified.

## Test result

```
$ python3 -m unittest -v test_wire.py
test_missing_version_is_rejected (test_wire.WireTests.test_missing_version_is_rejected) ... ok
test_v2_envelope_round_trip (test_wire.WireTests.test_v2_envelope_round_trip) ... ok

----------------------------------------------------------------------
Ran 2 tests in 0.000s

OK
```

Both tests pass (exit 0).

## Scope & caveats

- Parent-only frozen evaluator checks (summary-exists, coupling-recorded, write-scope, parent-interface-review) were not executed by this worker; results are retained for parent review (marked `not_run`, `exit_code` null). Parent acceptance is not claimed.
- The `verified_facts` carried an instruction to "keep source changes within retry.py only"; this was a carryover from a prior retry.py task and does not apply to the current producer/consumer assignment. Changes were confined to the declared allowed writes: `producer.py` and `consumer.py`.
