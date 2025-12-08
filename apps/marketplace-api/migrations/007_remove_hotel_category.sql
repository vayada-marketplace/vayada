-- ============================================
-- Remove category field from hotel_profiles
-- ============================================
-- Category should only exist at the listing level as accommodation_type
-- This aligns with business logic where each property can have its own type

-- Drop the trigger first (it references category)
DROP TRIGGER IF EXISTS trigger_check_hotel_profile_complete ON hotel_profiles;

-- Recreate the trigger function without category
CREATE OR REPLACE FUNCTION check_and_update_hotel_profile_complete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE hotel_profiles
  SET 
    profile_complete = (
      location IS NOT NULL AND
      location != '' AND
      location != 'Not specified'
    ),
    profile_completed_at = CASE
      WHEN (
        location IS NOT NULL AND
        location != '' AND
        location != 'Not specified'
      ) AND profile_complete = false
      THEN now()
      ELSE profile_completed_at
    END
  WHERE id = NEW.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger without category
CREATE TRIGGER trigger_check_hotel_profile_complete
AFTER INSERT OR UPDATE OF location, about ON hotel_profiles
FOR EACH ROW
EXECUTE FUNCTION check_and_update_hotel_profile_complete();

-- Remove the category column
ALTER TABLE public.hotel_profiles
DROP COLUMN IF EXISTS category;

-- Update the comment to reflect removal of category
COMMENT ON COLUMN public.hotel_profiles.profile_complete IS 'True when profile has been updated from defaults (location != "Not specified", about added)';

