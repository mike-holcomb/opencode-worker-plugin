def adapt_config(config):
    # The adapter currently drops keys it does not know about.
    return {"name": config.get("name")}
