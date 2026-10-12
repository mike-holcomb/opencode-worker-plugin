import json


def decode(raw):
    message = json.loads(raw)
    return message["request_id"], message["payload"]
