-- ============================================
-- COMPLETE CREATOR DATABASE SCHEMA
-- ============================================
-- 
-- USER FLOW:
-- 1. Registration: User registers with name, email, password, type='creator'
--    → Creates record in users table only
-- 2. Login: User logs in with email and password
-- 3. Profile Completion: User must complete creator profile before creating requests
--    → Creates record in creators table
--    → User can add platforms (creator_platforms table)
--
-- IMPORTANT: This schema assumes the following tables exist:
-- 1. users (already exists ✅)
-- 2. hotels (will be created later - FK constraint added after hotels table exists)
-- 3. collaborations (will be created later - optional for ratings)
--
-- ============================================

-- ============================================
-- TABLE 1: creators
-- ============================================
-- Stores creator-specific profile information
-- Created when user completes their profile after registration
-- One user with type='creator' has one creator profile

CREATE TABLE public.creators (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  
  -- REQUIRED fields for profile completion
  location text NOT NULL,
  short_description text NOT NULL,
  
  -- OPTIONAL fields
  portfolio_link text,
  phone text,
  
  -- Profile completion tracking
  profile_complete boolean NOT NULL DEFAULT false,
  profile_completed_at timestamp with time zone,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT creators_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_creators_user_id ON public.creators(user_id);
CREATE INDEX idx_creators_location ON public.creators(location);
CREATE INDEX idx_creators_profile_complete ON public.creators(profile_complete);

-- Comments
COMMENT ON TABLE public.creators IS 'Creator profiles linked to users table. Created when user completes their profile after registration. One user with type=creator has one creator profile.';
COMMENT ON COLUMN public.creators.profile_complete IS 'True when profile has all required fields (location, short_description) AND at least one platform added. User must have complete profile to create collaboration requests.';
COMMENT ON COLUMN public.creators.profile_completed_at IS 'Timestamp when profile was marked as complete (when all requirements met).';

-- ============================================
-- TABLE 2: creator_platforms
-- ============================================
-- Stores social media platforms for each creator
-- One creator can have multiple platforms (Instagram, TikTok, YouTube, Facebook)

CREATE TABLE public.creator_platforms (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  
  -- Platform basic information
  name text NOT NULL CHECK (name IN ('Instagram', 'TikTok', 'YouTube', 'Facebook')),
  handle text NOT NULL,
  followers integer NOT NULL DEFAULT 0,
  engagement_rate decimal(5, 2) NOT NULL DEFAULT 0.00,
  
  -- Analytics data (JSONB for flexibility)
  top_countries jsonb,
  top_age_groups jsonb,
  gender_split jsonb,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT creator_platforms_pkey PRIMARY KEY (id),
  CONSTRAINT creator_platforms_creator_platform_unique UNIQUE(creator_id, name)
);

-- Indexes
CREATE INDEX idx_creator_platforms_creator_id ON public.creator_platforms(creator_id);
CREATE INDEX idx_creator_platforms_name ON public.creator_platforms(name);

-- Comments
COMMENT ON TABLE public.creator_platforms IS 'Social media platforms for creators. One creator can have multiple platforms.';
COMMENT ON COLUMN public.creator_platforms.top_countries IS 'JSONB array of top countries: [{"country": "string", "percentage": number}]';
COMMENT ON COLUMN public.creator_platforms.top_age_groups IS 'JSONB array of age groups: [{"ageRange": "string", "percentage": number}]';
COMMENT ON COLUMN public.creator_platforms.gender_split IS 'JSONB object: {"male": number, "female": number}';

-- ============================================
-- TABLE 3: creator_ratings
-- ============================================
-- Stores ratings and reviews given to creators by hotels after collaborations
-- IMPORTANT: hotel_id FK constraint will be added after hotels table is created

CREATE TABLE public.creator_ratings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  collaboration_id uuid,
  
  -- Rating data
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT creator_ratings_pkey PRIMARY KEY (id),
  CONSTRAINT creator_ratings_collaboration_unique UNIQUE(collaboration_id)
);

-- Indexes
CREATE INDEX idx_creator_ratings_creator_id ON public.creator_ratings(creator_id);
CREATE INDEX idx_creator_ratings_hotel_id ON public.creator_ratings(hotel_id);
CREATE INDEX idx_creator_ratings_collaboration_id ON public.creator_ratings(collaboration_id);

-- Comments
COMMENT ON TABLE public.creator_ratings IS 'Ratings and reviews given to creators by hotels after collaborations.';
COMMENT ON COLUMN public.creator_ratings.hotel_id IS 'Foreign key to hotels table - add constraint after hotels table is created';
COMMENT ON COLUMN public.creator_ratings.collaboration_id IS 'Optional link to collaborations table - FK constraint will be added when collaborations table exists';

-- ============================================
-- FUTURE: Add Foreign Key Constraints
-- ============================================
-- Run these AFTER creating the hotels and collaborations tables:

-- Add FK constraint for hotel_id (after hotels table is created):
-- ALTER TABLE public.creator_ratings 
-- ADD CONSTRAINT fk_creator_ratings_hotel 
-- FOREIGN KEY (hotel_id) REFERENCES public.hotels(id) ON DELETE CASCADE;

-- Add FK constraint for collaboration_id (after collaborations table is created):
-- ALTER TABLE public.creator_ratings 
-- ADD CONSTRAINT fk_creator_ratings_collaboration 
-- FOREIGN KEY (collaboration_id) REFERENCES public.collaborations(id) ON DELETE SET NULL;

-- ============================================
-- OPTIONAL: Auto-update profile_complete
-- ============================================
-- Function to automatically update profile_complete when requirements are met

CREATE OR REPLACE FUNCTION check_and_update_profile_complete()
RETURNS TRIGGER AS $$
DECLARE
  target_creator_id uuid;
BEGIN
  -- Determine which creator_id to use based on which table triggered this
  IF TG_TABLE_NAME = 'creators' THEN
    target_creator_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'creator_platforms' THEN
    target_creator_id := COALESCE(NEW.creator_id, OLD.creator_id);
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE creators
  SET 
    profile_complete = (
      location IS NOT NULL AND
      location != '' AND
      short_description IS NOT NULL AND
      short_description != '' AND
      EXISTS (
        SELECT 1 FROM creator_platforms
        WHERE creator_id = target_creator_id
        AND name IS NOT NULL
        AND handle IS NOT NULL
        AND followers > 0
        AND engagement_rate > 0
      )
    ),
    profile_completed_at = CASE
      WHEN (
        location IS NOT NULL AND
        location != '' AND
        short_description IS NOT NULL AND
        short_description != '' AND
        EXISTS (
          SELECT 1 FROM creator_platforms
          WHERE creator_id = target_creator_id
          AND name IS NOT NULL
          AND handle IS NOT NULL
          AND followers > 0
          AND engagement_rate > 0
        )
      ) AND profile_complete = false
      THEN now()
      ELSE profile_completed_at
    END
  WHERE id = target_creator_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger on creators table updates
CREATE TRIGGER trigger_check_profile_complete_creators
AFTER INSERT OR UPDATE OF location, short_description ON creators
FOR EACH ROW
EXECUTE FUNCTION check_and_update_profile_complete();

-- Trigger on creator_platforms table changes
CREATE TRIGGER trigger_check_profile_complete_platforms
AFTER INSERT OR UPDATE OR DELETE ON creator_platforms
FOR EACH ROW
EXECUTE FUNCTION check_and_update_profile_complete();

