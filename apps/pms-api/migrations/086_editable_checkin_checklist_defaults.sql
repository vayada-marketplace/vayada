-- VAY-575: Seed editable property-wide check-in checklist defaults.
-- Existing templates, including intentionally empty templates, are preserved.

INSERT INTO checkin_checklist_templates (hotel_id, steps, updated_by)
SELECT
    h.id,
    '[
      {
        "id": "default-verify-guest-ids",
        "label": "Verify guest IDs / passports",
        "prompt": "Confirm passport or ID details are captured for every guest.",
        "type": "checkbox",
        "required": true,
        "system": false,
        "position": 0
      },
      {
        "id": "default-confirm-payment-status",
        "label": "Confirm payment / deposit status",
        "prompt": "Confirm the deposit, balance, or pay-at-property status before handover.",
        "type": "checkbox",
        "required": true,
        "system": false,
        "position": 1
      },
      {
        "id": "default-room-access",
        "label": "Assign room & hand over keys/access",
        "prompt": "Make sure the guest has their room assignment and access instructions.",
        "type": "checkbox",
        "required": true,
        "system": false,
        "position": 2
      }
    ]'::jsonb,
    NULL
FROM hotels h
WHERE NOT EXISTS (
    SELECT 1
    FROM checkin_checklist_templates t
    WHERE t.hotel_id = h.id
);
