-- ============================================
-- HOTEL PROFILE DATABASE SCHEMA
-- ============================================
-- 
-- USER FLOW:
-- 1. Registration: User registers with name, email, password, type='hotel'
--    → Creates record in users table
-- 2. Profile Creation: User creates hotel profile
--    → Creates record in hotel_profiles table
-- 3. Listing Creation: Hotel can create multiple property listings
--    → Creates records in hotel_listings table
--    → Can add collaboration offerings (listing_collaboration_offerings)
--    → Can add creator requirements (listing_creator_requirements)
--
-- IMPORTANT: This schema assumes the following tables exist:
-- 1. users (already exists ✅)
--
-- ============================================

-- ============================================
-- TABLE 1: hotel_profiles
-- ============================================
-- Stores main hotel account/profile information
-- One user with type='hotel' has one hotel profile
-- A hotel profile can own multiple property listings

CREATE TABLE public.hotel_profiles (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  
  -- Profile fields
  name text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'Resort', 'Hotel', 'Villa', 'Apartment', 'Hostel', 
    'Boutique Hotel', 'Luxury Hotel', 'Eco Resort', 
    'Spa Resort', 'Beach Resort'
  )),
  location text NOT NULL,
  picture text,
  website text,
  about text,
  email text NOT NULL,
  phone text,
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT hotel_profiles_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_hotel_profiles_user_id ON public.hotel_profiles(user_id);
CREATE INDEX idx_hotel_profiles_status ON public.hotel_profiles(status);

-- Comments
COMMENT ON TABLE public.hotel_profiles IS 'Main hotel account/profile. One user with type=hotel has one hotel profile. A hotel profile can own multiple property listings.';
COMMENT ON COLUMN public.hotel_profiles.email IS 'Contact email. Should match the email in users table but stored here for display/editing purposes.';
COMMENT ON COLUMN public.hotel_profiles.status IS 'Verification status: pending (default), verified, rejected, or suspended.';

-- ============================================
-- TABLE 2: hotel_listings
-- ============================================
-- Stores individual property listings for each hotel
-- One hotel profile can have multiple listings
-- Each listing represents a specific property that can offer collaborations

CREATE TABLE public.hotel_listings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  hotel_profile_id uuid NOT NULL REFERENCES public.hotel_profiles(id) ON DELETE CASCADE,
  
  -- Listing fields
  name text NOT NULL,
  location text NOT NULL,
  description text NOT NULL,
  accommodation_type text CHECK (accommodation_type IN (
    'Hotel', 'Resort', 'Boutique Hotel', 'Lodge', 'Apartment', 'Villa'
  )),
  images text[] DEFAULT '{}',
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT hotel_listings_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_hotel_listings_hotel_profile_id ON public.hotel_listings(hotel_profile_id);
CREATE INDEX idx_hotel_listings_status ON public.hotel_listings(status);

-- Comments
COMMENT ON TABLE public.hotel_listings IS 'Individual property listings for hotels. One hotel profile can have multiple listings. Each listing can have multiple collaboration offerings and one set of creator requirements.';
COMMENT ON COLUMN public.hotel_listings.images IS 'Array of image URLs for the property. Consider using a file storage service like S3.';
COMMENT ON COLUMN public.hotel_listings.status IS 'Listing verification status: pending (default), verified, or rejected.';

-- ============================================
-- TABLE 3: listing_collaboration_offerings
-- ============================================
-- Stores collaboration offerings for each listing
-- Each listing can have multiple offerings (one per collaboration type)
-- Types: Free Stay, Paid, Discount

CREATE TABLE public.listing_collaboration_offerings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  listing_id uuid NOT NULL REFERENCES public.hotel_listings(id) ON DELETE CASCADE,
  
  -- Collaboration details
  collaboration_type text NOT NULL CHECK (collaboration_type IN ('Free Stay', 'Paid', 'Discount')),
  availability_months text[] NOT NULL DEFAULT '{}',
  platforms text[] NOT NULL DEFAULT '{}' CHECK (
    array_length(platforms, 1) > 0 AND
    platforms <@ ARRAY['Instagram', 'TikTok', 'YouTube', 'Facebook']::text[]
  ),
  
  -- Type-specific fields (conditional based on collaboration_type)
  free_stay_min_nights integer CHECK (
    (collaboration_type = 'Free Stay' AND free_stay_min_nights IS NOT NULL) OR
    (collaboration_type != 'Free Stay' AND free_stay_min_nights IS NULL)
  ),
  free_stay_max_nights integer CHECK (
    (collaboration_type = 'Free Stay' AND free_stay_max_nights IS NOT NULL) OR
    (collaboration_type != 'Free Stay' AND free_stay_max_nights IS NULL)
  ),
  paid_max_amount decimal(10, 2) CHECK (
    (collaboration_type = 'Paid' AND paid_max_amount IS NOT NULL) OR
    (collaboration_type != 'Paid' AND paid_max_amount IS NULL)
  ),
  discount_percentage integer CHECK (
    (collaboration_type = 'Discount' AND discount_percentage IS NOT NULL) OR
    (collaboration_type != 'Discount' AND discount_percentage IS NULL)
  ),
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT listing_collaboration_offerings_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_listing_offerings_listing_id ON public.listing_collaboration_offerings(listing_id);
CREATE INDEX idx_listing_offerings_type ON public.listing_collaboration_offerings(collaboration_type);

-- Comments
COMMENT ON TABLE public.listing_collaboration_offerings IS 'Collaboration offerings for hotel listings. Each listing can have multiple offerings (one per collaboration type: Free Stay, Paid, Discount).';
COMMENT ON COLUMN public.listing_collaboration_offerings.availability_months IS 'Array of months when collaboration is available: e.g., ["January", "February", "March"].';
COMMENT ON COLUMN public.listing_collaboration_offerings.platforms IS 'Array of platforms where content should be posted: ["Instagram", "TikTok", "YouTube", "Facebook"]. At least one platform required.';
COMMENT ON COLUMN public.listing_collaboration_offerings.free_stay_min_nights IS 'Minimum nights for Free Stay collaboration. Required only if collaboration_type = "Free Stay".';
COMMENT ON COLUMN public.listing_collaboration_offerings.free_stay_max_nights IS 'Maximum nights for Free Stay collaboration. Required only if collaboration_type = "Free Stay". Must be >= min_nights.';
COMMENT ON COLUMN public.listing_collaboration_offerings.paid_max_amount IS 'Maximum payment amount for Paid collaboration. Required only if collaboration_type = "Paid".';
COMMENT ON COLUMN public.listing_collaboration_offerings.discount_percentage IS 'Discount percentage for Discount collaboration. Required only if collaboration_type = "Discount". Should be between 1-100.';

-- ============================================
-- TABLE 4: listing_creator_requirements
-- ============================================
-- Stores creator requirements for each listing
-- Each listing has one set of creator requirements

CREATE TABLE public.listing_creator_requirements (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  listing_id uuid NOT NULL UNIQUE REFERENCES public.hotel_listings(id) ON DELETE CASCADE,
  
  -- Requirement fields
  platforms text[] NOT NULL DEFAULT '{}' CHECK (
    platforms <@ ARRAY['Instagram', 'TikTok', 'YouTube', 'Facebook']::text[]
  ),
  min_followers integer,
  target_countries text[] NOT NULL DEFAULT '{}',
  target_age_min integer CHECK (target_age_min >= 0 AND target_age_min <= 100),
  target_age_max integer CHECK (target_age_max >= 0 AND target_age_max <= 100),
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT listing_creator_requirements_pkey PRIMARY KEY (id)
);

-- Indexes
CREATE INDEX idx_listing_requirements_listing_id ON public.listing_creator_requirements(listing_id);
CREATE INDEX idx_listing_requirements_min_followers ON public.listing_creator_requirements(min_followers);

-- Comments
COMMENT ON TABLE public.listing_creator_requirements IS 'Creator requirements for hotel listings. Each listing has one set of creator requirements.';
COMMENT ON COLUMN public.listing_creator_requirements.platforms IS 'Array of required platforms: ["Instagram", "TikTok", "YouTube", "Facebook"]. At least one platform required.';
COMMENT ON COLUMN public.listing_creator_requirements.min_followers IS 'Minimum follower count requirement (optional).';
COMMENT ON COLUMN public.listing_creator_requirements.target_countries IS 'Array of target audience countries. At least one country required.';
COMMENT ON COLUMN public.listing_creator_requirements.target_age_min IS 'Minimum age of target audience (optional, 0-100).';
COMMENT ON COLUMN public.listing_creator_requirements.target_age_max IS 'Maximum age of target audience (optional, 0-100). Must be >= target_age_min if both are provided.';

-- ============================================
-- ADDITIONAL CONSTRAINTS
-- ============================================
-- Add constraint to ensure max_nights >= min_nights for Free Stay
ALTER TABLE public.listing_collaboration_offerings
ADD CONSTRAINT check_free_stay_nights_range CHECK (
  (collaboration_type != 'Free Stay') OR
  (collaboration_type = 'Free Stay' AND free_stay_max_nights >= free_stay_min_nights)
);

-- Add constraint to ensure max_age >= min_age for creator requirements
ALTER TABLE public.listing_creator_requirements
ADD CONSTRAINT check_age_range CHECK (
  (target_age_min IS NULL OR target_age_max IS NULL) OR
  (target_age_min IS NOT NULL AND target_age_max IS NOT NULL AND target_age_max >= target_age_min)
);

-- Add constraint to ensure paid_max_amount > 0 for Paid collaborations
ALTER TABLE public.listing_collaboration_offerings
ADD CONSTRAINT check_paid_amount_positive CHECK (
  (collaboration_type != 'Paid') OR
  (collaboration_type = 'Paid' AND paid_max_amount > 0)
);

-- Add constraint to ensure discount_percentage is between 1-100
ALTER TABLE public.listing_collaboration_offerings
ADD CONSTRAINT check_discount_percentage_range CHECK (
  (collaboration_type != 'Discount') OR
  (collaboration_type = 'Discount' AND discount_percentage >= 1 AND discount_percentage <= 100)
);

-- ============================================
-- UPDATE EXISTING TABLES
-- ============================================
-- Add foreign key constraint to creator_ratings table
-- This was referenced in migration 003_creator_schema.sql but the constraint
-- was commented out waiting for the hotels table to be created

ALTER TABLE public.creator_ratings 
ADD CONSTRAINT fk_creator_ratings_hotel 
FOREIGN KEY (hotel_id) REFERENCES public.hotel_profiles(id) ON DELETE CASCADE;

