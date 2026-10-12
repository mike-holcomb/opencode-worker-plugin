def parse_number(value):
    # Known issue: whitespace is not accepted yet.
    if value != value.strip():
        raise ValueError("whitespace is not accepted")
    return int(value)
