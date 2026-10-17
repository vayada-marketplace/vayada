-- VAY-2270 (Marketplace removal step 3b). HOLD: merge only with Flamur's yes, and only after the
-- API that reads a stored creator_marketplace selection as absent is live (#3405).
--
-- The Creator Marketplace setup track is retired. Hotel Operations is the only track left:
-- - a selection that also named the Marketplace keeps Hotel Operations;
-- - a selection that named only the Marketplace is deleted (an organization then has no track
--   intent, exactly what the API already reports for it);
-- - setup sessions follow the same rule; the drafts and resume/completed markers of the retired
--   marketplace_preferences step go with it (drafts of deleted sessions cascade).
-- Revisions and timestamps stay: the API already shows these rows this way, so clients holding a
-- revision see no change. The CHECK constraints then allow Hotel Operations only and no longer
-- name the retired step.
SET LOCAL lock_timeout = '5s';

LOCK TABLE hotel_catalog.organization_setup_track_intents, hotel_catalog.property_setup_sessions,
  hotel_catalog.property_setup_step_drafts IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM hotel_catalog.property_setup_step_drafts WHERE step_id = 'marketplace_preferences';

DELETE FROM hotel_catalog.property_setup_sessions
WHERE NOT selected_tracks @> ARRAY['hotel_operations']::TEXT[];

UPDATE hotel_catalog.property_setup_sessions
SET selected_tracks = ARRAY['hotel_operations']::TEXT[],
    resume_step_id = NULLIF(resume_step_id, 'marketplace_preferences'),
    completed_step_ids = array_remove(completed_step_ids, 'marketplace_preferences')
WHERE selected_tracks <> ARRAY['hotel_operations']::TEXT[]
   OR resume_step_id = 'marketplace_preferences'
   OR 'marketplace_preferences' = ANY(completed_step_ids);

DELETE FROM hotel_catalog.organization_setup_track_intents
WHERE NOT selected_tracks @> ARRAY['hotel_operations']::TEXT[];

UPDATE hotel_catalog.organization_setup_track_intents
SET selected_tracks = ARRAY['hotel_operations']::TEXT[]
WHERE selected_tracks <> ARRAY['hotel_operations']::TEXT[];

ALTER TABLE hotel_catalog.organization_setup_track_intents
  DROP CONSTRAINT chk_organization_setup_track_intents_tracks,
  ADD CONSTRAINT chk_organization_setup_track_intents_tracks
    CHECK (selected_tracks = ARRAY['hotel_operations']::TEXT[]);

ALTER TABLE hotel_catalog.property_setup_sessions
  DROP CONSTRAINT chk_property_setup_sessions_tracks,
  ADD CONSTRAINT chk_property_setup_sessions_tracks
    CHECK (selected_tracks = ARRAY['hotel_operations']::TEXT[]),
  DROP CONSTRAINT chk_property_setup_sessions_resume_step,
  ADD CONSTRAINT chk_property_setup_sessions_resume_step
    CHECK (
      resume_step_id IS NULL
      OR resume_step_id IN (
        'present_hotel',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      )
    ),
  DROP CONSTRAINT chk_property_setup_sessions_completed_steps,
  ADD CONSTRAINT chk_property_setup_sessions_completed_steps
    CHECK (
      cardinality(completed_step_ids) <= 8
      AND array_position(completed_step_ids, NULL) IS NULL
      AND hotel_catalog.property_setup_step_ids_are_unique(completed_step_ids)
      AND completed_step_ids <@ ARRAY[
        'present_hotel',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      ]::TEXT[]
    );

ALTER TABLE hotel_catalog.property_setup_step_drafts
  DROP CONSTRAINT chk_property_setup_step_drafts_step,
  ADD CONSTRAINT chk_property_setup_step_drafts_step
    CHECK (
      step_id IN (
        'present_hotel',
        'booking_design',
        'rooms',
        'pricing',
        'calendar',
        'guest_experience',
        'payments',
        'review'
      )
    );
