-- ============================================
-- Add profile_complete tracking to hotel_profiles
-- ============================================
-- This adds the same profile completion tracking pattern as creators

-- Add profile completion fields
ALTER TABLE public.hotel_profiles
ADD COLUMN profile_complete boolean NOT NULL DEFAULT false;

ALTER TABLE public.hotel_profiles
ADD COLUMN profile_completed_at timestamp with time zone;

-- Create index for faster queries
CREATE INDEX idx_hotel_profiles_profile_complete ON public.hotel_profiles(profile_complete);

-- Comments
COMMENT ON COLUMN public.hotel_profiles.profile_complete IS 'True when profile has been updated from defaults (location != "Not specified", and optionally category updated, about added)';
COMMENT ON COLUMN public.hotel_profiles.profile_completed_at IS 'Timestamp when profile was marked as complete';

-- ============================================
-- Function to automatically update profile_complete for hotels
-- ============================================

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

-- Trigger on hotel_profiles table updates
CREATE TRIGGER trigger_check_hotel_profile_complete
AFTER INSERT OR UPDATE OF location, category, about ON hotel_profiles
FOR EACH ROW
EXECUTE FUNCTION check_and_update_hotel_profile_complete();

-- Update existing hotel profiles to set profile_complete based on current data
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
    )
    THEN updated_at
    ELSE NULL
  END;

