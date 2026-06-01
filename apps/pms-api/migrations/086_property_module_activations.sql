CREATE TABLE IF NOT EXISTS property_module_activations (
    hotel_id UUID NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    activated_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (hotel_id, module_id),
    CONSTRAINT property_module_activations_module_id_format
        CHECK (module_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS idx_property_module_activations_hotel_active
    ON property_module_activations (hotel_id, is_active);
