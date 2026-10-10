-- Migration: 0476_pms_property_navigation_modules
-- Owner: domain-pms / VAY-2078
--
-- Feature Hub switches for PMS modules that only decide whether the module's sidebar item
-- shows. A switch never gates the module's pages, APIs or data, so turning one off loses
-- nothing. A property without a row has the module off, which is the new-property default.

CREATE TABLE pms.property_navigation_modules (
  property_id     UUID        NOT NULL
                              REFERENCES hotel_catalog.properties(id) ON DELETE CASCADE,
  module_id       TEXT        NOT NULL CHECK (module_id IN ('inbox', 'reviews')),
  is_active       BOOLEAN     NOT NULL,
  activated_at    TIMESTAMPTZ,
  deactivated_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, module_id),
  CONSTRAINT chk_pms_navigation_module_activation CHECK (
    NOT is_active OR activated_at IS NOT NULL
  )
);

COMMENT ON TABLE pms.property_navigation_modules IS
  'Feature Hub switches for PMS sidebar modules (VAY-2078); visibility only, never access.';

-- Properties that already use a module keep its sidebar item. Inbox counts conversations and
-- saved replies; Reviews counts channel reviews and direct guest review submissions.
INSERT INTO pms.property_navigation_modules (property_id, module_id, is_active, activated_at)
SELECT used.property_id, used.module_id, TRUE, now()
FROM (
  SELECT property_id, 'inbox' AS module_id FROM pms.message_threads
  UNION
  SELECT property_id, 'inbox' FROM pms.message_quick_replies
  UNION
  SELECT property_id, 'reviews' FROM pms.channel_reviews
  UNION
  SELECT property_id, 'reviews' FROM pms.guest_review_submissions
) AS used
ON CONFLICT (property_id, module_id) DO NOTHING;
