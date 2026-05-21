ALTER TABLE affiliates
    ADD COLUMN bank_account_holder TEXT NOT NULL DEFAULT '',
    ADD COLUMN bank_swift_bic      TEXT NOT NULL DEFAULT '',
    ADD COLUMN bank_name           TEXT NOT NULL DEFAULT '',
    ADD COLUMN bank_country        TEXT NOT NULL DEFAULT '';
