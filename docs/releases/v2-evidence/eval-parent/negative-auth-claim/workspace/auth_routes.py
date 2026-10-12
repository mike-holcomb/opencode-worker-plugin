def health():
    return "ok"


def profile(session):
    if not session:
        raise PermissionError("missing session")
    return "profile"
