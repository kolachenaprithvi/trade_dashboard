import pytest
from fastapi import HTTPException

from app.config import settings
from app.main import empty_snapshot, health, require_password, validate_option_symbol


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
