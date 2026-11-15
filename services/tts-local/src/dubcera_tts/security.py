from __future__ import annotations

import secrets
from urllib.parse import urlparse

from fastapi import HTTPException, Request, status

from .config import ServiceConfig


def is_origin_allowed(origin: str | None, config: ServiceConfig) -> bool:
    if not origin:
        # Non-browser local CLI / benchmark script with valid X-DubCera-Token
        return True

    parsed = urlparse(origin)
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()

    if scheme == "chrome-extension":
        if not config.allowed_extension_ids:
            # In dev mode before extension ID is pinned, accept chrome-extension://* when paired with valid token
            return config.dev_sandbox_enabled
        return hostname in config.allowed_extension_ids

    if config.dev_sandbox_enabled and scheme in ("http", "https") and hostname in ("127.0.0.1", "localhost"):
        return True

    return False


def verify_request_security(request: Request, config: ServiceConfig) -> None:
    origin = request.headers.get("origin")
    if not is_origin_allowed(origin, config):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Origin '{origin}' is not authorized to access DubCera local TTS.",
        )

    provided_token = request.headers.get("x-dubcera-token") or request.query_params.get("token")
    if not provided_token or not secrets.compare_digest(provided_token, config.auth_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid X-DubCera-Token.",
        )
