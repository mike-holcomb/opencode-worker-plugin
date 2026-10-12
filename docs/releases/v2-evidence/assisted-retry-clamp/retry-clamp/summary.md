# Retry Clamp Worker Summary

## Objective
Clamp the retry count at the public boundary in `retry.py`: negative values behave as zero, values above three behave as three, and values zero through three are preserved. Keep the public function name unchanged. Do not change tests.

## Change
`retry.py` — `retries_for(requested)`:
- `requested < 0` -> `0`
- `requested > 3` -> `3`
- otherwise -> `requested`

Public function name `retries_for` preserved. `test_retry.py` left unchanged.

## Check command and result
Command: `python3 -m unittest -v test_retry.py` (run in workspace)

Result: **passed** (exit code 0)
```
test_above_three_is_three (test_retry.RetryBoundaryTests.test_above_three_is_three) ... ok
test_negative_is_zero (test_retry.RetryBoundaryTests.test_negative_is_zero) ... ok
test_zero_and_three_are_preserved (test_retry.RetryBoundaryTests.test_zero_and_three_are_preserved) ... ok

Ran 3 tests in 0.000s

OK
```

## Parent-only checks
The following frozen evaluator checks were not run by this worker per the verified context (parent-only): `summary-exists`, `check-recorded`, `write-scope`, `parent-code-review`. They are recorded as `not_run` in `result.json`.
