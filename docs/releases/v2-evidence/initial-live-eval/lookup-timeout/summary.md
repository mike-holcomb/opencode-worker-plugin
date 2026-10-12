# Lookup Timeout Investigation — Worker Report

## Defining path and symbol

The request timeout definition lives in **`config.py`** at module level:

- **Symbol:** `DEFAULT_TIMEOUT_SECONDS`
- **Value:** `12`
- **File / line:** `config.py:1`

A derived helper, also in `config.py`, resolves the effective timeout per endpoint:

- **Symbol:** `timeout_for` (function)
- **File / line:** `config.py:4-5`
- **Behavior:** returns `3` when `endpoint == "health"`, otherwise returns `DEFAULT_TIMEOUT_SECONDS` (`12`).

## Caller path and symbol

The caller that uses the timeout is **`client.py`**:

- **Symbol:** `Client.request` (method)
- **File / line:** `client.py:5-6`
- **Call site:** `Client.request` imports `timeout_for` from `config` (line 1) and, when no explicit `timeout` argument is supplied, calls `timeout_for(endpoint)` to obtain the effective timeout (line 6).

## Distinction between default and override

- **Default** — `DEFAULT_TIMEOUT_SECONDS = 12`: the baseline request timeout applied to all endpoints except "health".
- **Override** — `timeout_for` returns `3` for the `"health"` endpoint, providing a shorter timeout for health-check requests.

## Evidence (cited lines)

| File | Line | Content |
|------|------|---------|
| config.py | 1 | `DEFAULT_TIMEOUT_SECONDS = 12` |
| config.py | 4-5 | `def timeout_for(endpoint=None):` → `return 3 if endpoint == "health" else DEFAULT_TIMEOUT_SECONDS` |
| client.py | 1 | `from config import timeout_for` |
| client.py | 5-6 | `def request(self, endpoint, timeout=None):` → `effective_timeout = timeout if timeout is not None else timeout_for(endpoint)` |
