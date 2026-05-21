-- ============================================
-- Fix hotel profile_complete trigger to check about and website
-- ============================================
-- The status endpoint requires location, about, and website to be filled,
-- but the trigger only checked location. This migration updates the trigger
-- to match the status endpoint logic.

-- Drop the existing trigger
DROP TRIGGER IF EXISTS trigger_check_hotel_profile_complete ON hotel_profiles;

-- Recreate the trigger function to check location, about, and website
CREATE OR REPLACE FUNCTION check_and_update_hotel_profile_complete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE hotel_profiles
  SET 
    profile_complete = (
      location IS NOT NULL AND
      location != '' AND
      location != 'Not specified' AND
      about IS NOT NULL AND
      about != '' AND
      website IS NOT NULL AND
      website != ''
    ),
    profile_completed_at = CASE
      WHEN (
        location IS NOT NULL AND
        location != '' AND
        location != 'Not specified' AND
        about IS NOT NULL AND
        about != '' AND
        website IS NOT NULL AND
        website != ''
      ) AND profile_complete = false
      THEN now()
      ELSE profile_completed_at
    END
  WHERE id = NEW.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger to fire on location, about, and website updates
CREATE TRIGGER trigger_check_hotel_profile_complete
AFTER INSERT OR UPDATE OF location, about, website ON hotel_profiles
FOR EACH ROW
EXECUTE FUNCTION check_and_update_hotel_profile_complete();

-- Update the comment to reflect the new requirements
COMMENT ON COLUMN public.hotel_profiles.profile_complete IS 'True when profile has all required fields: location != "Not specified", about is filled, and website is filled';

-- Update existing hotel profiles to set profile_complete based on new criteria
UPDATE hotel_profiles
SET 
  profile_complete = (
    location IS NOT NULL AND
    location != '' AND
    location != 'Not specified' AND
    about IS NOT NULL AND
    about != '' AND
    website IS NOT NULL AND
    website != ''
  ),
  profile_completed_at = CASE
    WHEN (
      location IS NOT NULL AND
      location != '' AND
      location != 'Not specified' AND
      about IS NOT NULL AND
      about != '' AND
      website IS NOT NULL AND
      website != ''
    ) AND profile_complete = false
    THEN now()
    ELSE profile_completed_at
  END;

