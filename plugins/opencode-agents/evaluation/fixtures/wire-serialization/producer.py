import json


def encode(request_id, payload):
    """Starting producer; update it for the envelope required by test_wire.py."""
    return json.dumps({"request_id": request_id, "payload": payload})
