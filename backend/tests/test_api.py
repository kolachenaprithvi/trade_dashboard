import asyncio

import pytest
from fastapi import HTTPException

from app.config import settings
from app.main import empty_snapshot, health, require_password, validate_option_symbol
from app.upstox import UpstoxClient


def test_health_does_not_expose_secrets(monkeypatch):
    monkeypatch.setattr(settings, "upstox_access_token", "very-secret-token")
    monkeypatch.setattr(settings, "dashboard_password", "very-secret-password")
    response = health()
    assert response["ok"] is True
    assert "very-secret" not in str(response)


def test_dashboard_password_is_checked_without_disclosing_it(monkeypatch):
    monkeypatch.setattr(settings, "dashboard_password", "correct horse battery")
    with pytest.raises(HTTPException) as result:
        require_password("wrong")
    assert result.value.status_code == 401
    assert "correct horse" not in str(result.value.detail)
    require_password("correct horse battery")


def test_empty_token_returns_explicit_empty_state(monkeypatch):
    monkeypatch.setattr(settings, "upstox_access_token", "")
    response = empty_snapshot()
    assert response["mode"] == "demo"
    assert response["indices"] == {}
    assert response["asOf"] is None


def test_unknown_option_symbol_is_rejected():
    with pytest.raises(HTTPException) as result:
        validate_option_symbol("STOCK")
    assert result.value.status_code == 404


def test_upstox_client_sends_bearer_token(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        def json(self):
            return {"status": "success", "data": {}}

    class Client:
        def __init__(self, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, params, headers):
            captured["authorization"] = headers["Authorization"]
            return Response()

    monkeypatch.setattr("app.upstox.httpx.AsyncClient", Client)

    result = asyncio.run(UpstoxClient("test-access-token").get("/test", {}))

    assert result == {}
    assert captured["authorization"] == "Bearer test-access-token"
