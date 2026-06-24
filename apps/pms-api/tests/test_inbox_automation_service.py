from datetime import date

from app.services.inbox_automation_service import render_template, variables_for_booking


def test_renders_guest_template_variables():
    variables = variables_for_booking(
        {
            "guest_first_name": "Ada",
            "guest_last_name": "Lovelace",
            "hotel_name": "Vayada House",
            "check_in": date(2026, 7, 1),
            "check_out": date(2026, 7, 4),
            "check_in_time": "15:00",
            "wifi_password": "hello-wifi",
            "hotel_address": "1 Main Street",
        }
    )

    assert variables["guest"] == "Ada"
    assert variables["nights"] == "3"
    assert render_template("Hi {{guest}}, WiFi: {{wifi}}", variables) == "Hi Ada, WiFi: hello-wifi"
    assert render_template("Keep {{unknown}}", variables) == "Keep {{unknown}}"
