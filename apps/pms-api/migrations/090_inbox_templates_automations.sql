-- VAY-657: Guest communication templates, automation rules, and idempotent sends.

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS automated BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE hotels
    ADD COLUMN IF NOT EXISTS wifi_password TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS host_contact_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS google_review_link TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum
        WHERE enumlabel = 'direct'
          AND enumtypid = 'message_source'::regtype
    ) THEN
        ALTER TYPE message_source ADD VALUE 'direct';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    icon TEXT NOT NULL DEFAULT 'chat',
    content TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_templates_hotel
    ON message_templates (hotel_id, sort_order, name);

CREATE TABLE IF NOT EXISTS guest_automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    template_id UUID REFERENCES message_templates(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'calendar',
    description TEXT NOT NULL DEFAULT '',
    trigger_event TEXT NOT NULL DEFAULT 'before_check_in',
    days_offset INT NOT NULL DEFAULT 1,
    send_time TIME NOT NULL DEFAULT '10:00',
    audience TEXT NOT NULL DEFAULT 'all',
    delivery_channel TEXT NOT NULL DEFAULT 'smart',
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_guest_automations_trigger_event
        CHECK (trigger_event IN ('before_check_in', 'day_of_check_in', 'after_check_out', 'day_of_check_out')),
    CONSTRAINT chk_guest_automations_audience
        CHECK (audience IN ('all', 'direct', 'ota', 'booking.com', 'airbnb')),
    CONSTRAINT chk_guest_automations_delivery
        CHECK (delivery_channel IN ('smart', 'ota_only', 'email_only'))
);
CREATE INDEX IF NOT EXISTS idx_guest_automations_hotel
    ON guest_automations (hotel_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_guest_automations_active
    ON guest_automations (is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS automation_sends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automation_id UUID NOT NULL REFERENCES guest_automations(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    message_thread_id UUID REFERENCES message_threads(id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    delivery_channel TEXT NOT NULL DEFAULT 'smart',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (automation_id, booking_id),
    CONSTRAINT chk_automation_sends_status
        CHECK (status IN ('pending', 'sent', 'skipped', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_automation_sends_booking
    ON automation_sends (booking_id);

WITH defaults(name, category, icon, content, sort_order) AS (
    VALUES
        ('Check-in details', 'pre_arrival', 'key', 'Hi {{guest}}, we look forward to welcoming you to {{property}} on {{checkin_date}}. Check-in starts at {{checkin_time}}. Address: {{address}}. WiFi: {{wifi}}.', 10),
        ('Airport shuttle', 'pre_arrival', 'shuttle', 'Hi {{guest}}, would you like us to arrange an airport shuttle to {{property}} for your arrival on {{checkin_date}}? Reply here and we will confirm availability.', 20),
        ('Restaurant tips', 'in_stay', 'utensils', 'Hi {{guest}}, here are a few nearby restaurant tips from {{host}}. Let us know what kind of food you are looking for and we will point you in the right direction.', 30),
        ('Late checkout OK', 'in_stay', 'clock', 'Hi {{guest}}, late checkout is approved. You can stay until the agreed time. Enjoy the rest of your stay at {{property}}.', 40),
        ('Review request', 'post_stay', 'star', 'Hi {{guest}}, thank you for staying with us at {{property}}. If you enjoyed your stay, we would really appreciate a review here: {{review_link}}', 50),
        ('Refer-a-Guest', 'post_stay', 'gift', 'Hi {{guest}}, if you know someone who would love {{property}}, share this referral link: {{referral_link}}. Thank you again for staying with us.', 60)
)
INSERT INTO message_templates (hotel_id, name, category, icon, content, is_default, sort_order)
SELECT h.id, d.name, d.category, d.icon, d.content, true, d.sort_order
FROM hotels h
CROSS JOIN defaults d
WHERE NOT EXISTS (
    SELECT 1 FROM message_templates mt
    WHERE mt.hotel_id = h.id AND mt.name = d.name
);

WITH automation_defaults(name, icon, description, trigger_event, days_offset, send_time, audience, delivery_channel, template_name, is_active, sort_order) AS (
    VALUES
        ('1 day before arrival', 'key', 'Send check-in details before the guest travels.', 'before_check_in', 1, '10:00'::time, 'all', 'smart', 'Check-in details', true, 10),
        ('Morning of arrival', 'shuttle', 'Offer airport transfer and arrival help.', 'day_of_check_in', 0, '09:00'::time, 'all', 'smart', 'Airport shuttle', true, 20),
        ('Day after checkout', 'star', 'Ask recent guests for a review.', 'after_check_out', 1, '10:00'::time, 'all', 'email_only', 'Review request', true, 30),
        ('Refer-a-Guest follow-up', 'gift', 'Invite happy guests to refer friends.', 'after_check_out', 14, '10:00'::time, 'all', 'email_only', 'Refer-a-Guest', false, 40)
)
INSERT INTO guest_automations (
    hotel_id, template_id, name, icon, description, trigger_event, days_offset,
    send_time, audience, delivery_channel, is_active, sort_order
)
SELECT
    h.id,
    mt.id,
    d.name,
    d.icon,
    d.description,
    d.trigger_event,
    d.days_offset,
    d.send_time,
    d.audience,
    d.delivery_channel,
    d.is_active,
    d.sort_order
FROM hotels h
JOIN automation_defaults d ON true
JOIN message_templates mt ON mt.hotel_id = h.id AND mt.name = d.template_name
WHERE NOT EXISTS (
    SELECT 1 FROM guest_automations ga
    WHERE ga.hotel_id = h.id AND ga.name = d.name
);
