from app.services.booking_service import _resolve_deposit_snapshot


def test_resolve_deposit_snapshot_rounds_to_cents():
    room = {
        "rate_deposit_settings": {
            "flexible": {
                "enabled": True,
                "percentage": 50,
            }
        }
    }

    deposit = _resolve_deposit_snapshot(room, "flexible", 251)

    assert deposit.required is True
    assert deposit.percentage == 50
    assert deposit.amount == 125.5
    assert deposit.balance == 125.5


def test_resolve_deposit_snapshot_leaves_rate_without_config_unchanged():
    room = {
        "rate_deposit_settings": {
            "flexible": {
                "enabled": True,
                "percentage": 50,
            }
        }
    }

    deposit = _resolve_deposit_snapshot(room, "nonrefundable", 500)

    assert deposit.required is False
    assert deposit.percentage is None
    assert deposit.amount == 0
    assert deposit.balance == 500
