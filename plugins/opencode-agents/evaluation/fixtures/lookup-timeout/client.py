from config import timeout_for


class Client:
    def request(self, endpoint, timeout=None):
        effective_timeout = timeout if timeout is not None else timeout_for(endpoint)
        return endpoint, effective_timeout
