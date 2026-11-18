"""What can go wrong with a request, in the server's own terms; api.py turns these into HTTP answers.
A bad value in a request is a ValueError (400)."""


class NotFound(LookupError):
    """404: no such thing (or not one this profile may see)."""


class Forbidden(PermissionError):
    """403: this profile may not do that."""
