import json

ENVELOPE_VERSION = 2


def encode(request_id, payload):
    """Encode a request into the v2 wire envelope."""
    envelope = {
        "version": ENVELOPE_VERSION,
        "request": {"id": request_id, "body": payload},
    }
    return json.dumps(envelope)
