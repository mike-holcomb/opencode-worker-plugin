def retries_for(requested):
    """Return the retry count accepted by the public boundary."""
    if requested < 0:
        return 0
    if requested > 3:
        return 3
    return requested
