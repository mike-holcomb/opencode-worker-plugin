def retries_for(requested):
    """Return the retry count accepted by the public boundary."""
    return max(0, min(requested, 3))
