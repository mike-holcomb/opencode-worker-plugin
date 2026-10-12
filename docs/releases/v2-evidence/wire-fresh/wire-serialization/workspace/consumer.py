import json

ENVELOPE_VERSION = 2


def decode(raw):
    message = json.loads(raw)
    if message.get("version") != ENVELOPE_VERSION:
        raise ValueError("missing version")
    request = message["request"]
    return request["id"], request["body"]
