DEFAULT_TIMEOUT_SECONDS = 12


def timeout_for(endpoint=None):
    return 3 if endpoint == "health" else DEFAULT_TIMEOUT_SECONDS
