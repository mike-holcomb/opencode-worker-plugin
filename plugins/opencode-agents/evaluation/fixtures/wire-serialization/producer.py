import json


def encode(request_id, payload, version=1):
    """Current fixture producer; the worker must add the v2 envelope."""
    if version != 1:
        raise ValueError("only v1 is implemented in the starting checkout")
    return json.dumps({"request_id": request_id, "payload": payload})
