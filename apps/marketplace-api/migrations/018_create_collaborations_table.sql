-- ============================================
-- COLLABORATIONS TABLE
-- ============================================
-- 
-- This table stores collaboration applications/invitations between creators and hotels.
-- Supports bidirectional collaborations:
--   1. Creator → Hotel: Creator applies for a collaboration with a hotel listing
--   2. Hotel → Creator: Hotel invites a creator for a collaboration
--
-- USER FLOW:
-- 1. Creator or Hotel creates a collaboration application/invitation
--    → Creates record in collaborations table with status='pending'
-- 2. Recipient responds (accepts/declines)
--    → Updates status to 'accepted' or 'declined', sets responded_at
-- 3. Collaboration is completed (after content is delivered)
--    → Updates status to 'completed', sets completed_at
-- 4. Either party can cancel (if pending or accepted)
--    → Updates status to 'cancelled', sets cancelled_at
--
-- IMPORTANT: This schema assumes the following tables exist:
-- 1. creators (already exists ✅)
-- 2. hotel_profiles (already exists ✅)
-- 3. hotel_listings (already exists ✅)
-- 4. creator_ratings (already exists ✅ - will link to this table)
--
-- ============================================

-- ============================================
-- TABLE: collaborations
-- ============================================

CREATE TABLE public.collaborations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  
  -- Core identification
  initiator_type text NOT NULL CHECK (initiator_type IN ('creator', 'hotel')),
  creator_id uuid NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL REFERENCES public.hotel_profiles(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.hotel_listings(id) ON DELETE CASCADE,
  
  -- Status tracking
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'completed', 'cancelled')),
  
  -- Communication
  why_great_fit text,  -- For creator applications (max 500 chars, validated in application layer)
  
  -- Collaboration terms
  collaboration_type text CHECK (collaboration_type IN ('Free Stay', 'Paid', 'Discount')),
  free_stay_min_nights integer,
  free_stay_max_nights integer,
  paid_amount decimal(10, 2),
  discount_percentage integer CHECK (discount_percentage IS NULL OR (discount_percentage >= 1 AND discount_percentage <= 100)),
  
  -- Dates and availability
  travel_date_from date,      -- For creator applications
  travel_date_to date,        -- For creator applications
  preferred_date_from date,   -- For hotel invitations
  preferred_date_to date,     -- For hotel invitations
  preferred_months text[],    -- Array of month abbreviations: ['Jan', 'Feb', 'Mar', ...]
  
  -- Platform deliverables (JSONB for flexibility)
  platform_deliverables jsonb NOT NULL,
  -- Structure: [
  --   {
  --     "platform": "Instagram" | "TikTok" | "YouTube" | "Facebook",
  --     "deliverables": [
  --       {"type": "Instagram Post", "quantity": 2},
  --       {"type": "Instagram Stories", "quantity": 5}
  --     ]
  --   }
  -- ]
  
  -- Consent
  consent boolean,  -- For creator applications (must be true)
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  responded_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  completed_at timestamp with time zone,
  
  CONSTRAINT collaborations_pkey PRIMARY KEY (id)
);

-- ============================================
-- CONSTRAINTS
-- ============================================

-- Prevent duplicate active collaborations between same creator and listing
CREATE UNIQUE INDEX idx_collaborations_unique_active 
ON public.collaborations (listing_id, creator_id) 
WHERE status IN ('pending', 'accepted');

-- Validate collaboration type specific fields
ALTER TABLE public.collaborations
ADD CONSTRAINT check_free_stay_fields 
CHECK (
  (collaboration_type != 'Free Stay') OR 
  (collaboration_type = 'Free Stay' AND free_stay_min_nights IS NOT NULL AND free_stay_max_nights IS NOT NULL)
);

ALTER TABLE public.collaborations
ADD CONSTRAINT check_paid_fields 
CHECK (
  (collaboration_type != 'Paid') OR 
  (collaboration_type = 'Paid' AND paid_amount IS NOT NULL AND paid_amount > 0)
);

ALTER TABLE public.collaborations
ADD CONSTRAINT check_discount_fields 
CHECK (
  (collaboration_type != 'Discount') OR 
  (collaboration_type = 'Discount' AND discount_percentage IS NOT NULL)
);

-- Validate date ranges
ALTER TABLE public.collaborations
ADD CONSTRAINT check_travel_dates 
CHECK (travel_date_from IS NULL OR travel_date_to IS NULL OR travel_date_to >= travel_date_from);

ALTER TABLE public.collaborations
ADD CONSTRAINT check_preferred_dates 
CHECK (preferred_date_from IS NULL OR preferred_date_to IS NULL OR preferred_date_to >= preferred_date_from);

-- Validate platform_deliverables structure (basic validation - detailed validation in application layer)
ALTER TABLE public.collaborations
ADD CONSTRAINT check_platform_deliverables_not_empty 
CHECK (jsonb_array_length(platform_deliverables) > 0);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_collaborations_creator_id ON public.collaborations(creator_id);
CREATE INDEX idx_collaborations_hotel_id ON public.collaborations(hotel_id);
CREATE INDEX idx_collaborations_listing_id ON public.collaborations(listing_id);
CREATE INDEX idx_collaborations_status ON public.collaborations(status);
CREATE INDEX idx_collaborations_initiator_type ON public.collaborations(initiator_type);
CREATE INDEX idx_collaborations_created_at ON public.collaborations(created_at DESC);

-- Composite index for common queries (creator's collaborations by status)
CREATE INDEX idx_collaborations_creator_status ON public.collaborations(creator_id, status);

-- Composite index for common queries (hotel's collaborations by status)
CREATE INDEX idx_collaborations_hotel_status ON public.collaborations(hotel_id, status);

-- Composite index for listing-based queries
CREATE INDEX idx_collaborations_listing_status ON public.collaborations(listing_id, status);

-- ============================================
-- COMMENTS
-- ============================================

COMMENT ON TABLE public.collaborations IS 'Collaboration applications and invitations between creators and hotels. Supports bidirectional collaborations (creator-initiated or hotel-initiated).';

COMMENT ON COLUMN public.collaborations.initiator_type IS 'Who initiated the collaboration: "creator" (creator applied) or "hotel" (hotel invited)';
COMMENT ON COLUMN public.collaborations.status IS 'Collaboration status: pending (awaiting response), accepted (agreed to collaborate), declined (rejected), completed (finished), cancelled (cancelled by either party)';
COMMENT ON COLUMN public.collaborations.why_great_fit IS 'Message from creator explaining why they are a good fit for the collaboration (max 500 chars, validated in application layer)';
COMMENT ON COLUMN public.collaborations.collaboration_type IS 'Type of collaboration: "Free Stay", "Paid", or "Discount". Required for hotel invitations, optional for creator applications (creators can propose custom terms)';
COMMENT ON COLUMN public.collaborations.free_stay_min_nights IS 'Minimum nights for Free Stay collaboration. Required if collaboration_type is "Free Stay"';
COMMENT ON COLUMN public.collaborations.free_stay_max_nights IS 'Maximum nights for Free Stay collaboration. Required if collaboration_type is "Free Stay". Must be >= free_stay_min_nights';
COMMENT ON COLUMN public.collaborations.paid_amount IS 'Payment amount for Paid collaboration. Required if collaboration_type is "Paid". Must be > 0';
COMMENT ON COLUMN public.collaborations.discount_percentage IS 'Discount percentage for Discount collaboration. Required if collaboration_type is "Discount". Must be between 1-100';
COMMENT ON COLUMN public.collaborations.travel_date_from IS 'Proposed check-in date for creator applications';
COMMENT ON COLUMN public.collaborations.travel_date_to IS 'Proposed check-out date for creator applications';
COMMENT ON COLUMN public.collaborations.preferred_date_from IS 'Preferred start date for hotel invitations';
COMMENT ON COLUMN public.collaborations.preferred_date_to IS 'Preferred end date for hotel invitations';
COMMENT ON COLUMN public.collaborations.preferred_months IS 'Array of preferred month abbreviations (e.g., ["Jan", "Feb", "Mar"]). Used when specific dates are not provided';
COMMENT ON COLUMN public.collaborations.platform_deliverables IS 'JSONB array of platform deliverables. Structure: [{"platform": "Instagram", "deliverables": [{"type": "Instagram Post", "quantity": 2}]}]';
COMMENT ON COLUMN public.collaborations.consent IS 'Consent flag for creator applications. Must be true for creator-initiated collaborations';
COMMENT ON COLUMN public.collaborations.responded_at IS 'Timestamp when recipient responded (accepted or declined)';
COMMENT ON COLUMN public.collaborations.cancelled_at IS 'Timestamp when collaboration was cancelled';
COMMENT ON COLUMN public.collaborations.completed_at IS 'Timestamp when collaboration was marked as completed';

-- ============================================
-- UPDATE EXISTING TABLES
-- ============================================
-- Add foreign key constraint to creator_ratings table
-- This was referenced in migration 003_creator_schema.sql but the constraint
-- was commented out waiting for the collaborations table to be created

ALTER TABLE public.creator_ratings 
ADD CONSTRAINT fk_creator_ratings_collaboration 
FOREIGN KEY (collaboration_id) REFERENCES public.collaborations(id) ON DELETE SET NULL;

COMMENT ON CONSTRAINT fk_creator_ratings_collaboration ON public.creator_ratings IS 'Links ratings to the specific collaboration. Ratings can only be created after collaboration is completed.';

-- ============================================
-- TRIGGER: Update updated_at timestamp
-- ============================================

CREATE OR REPLACE FUNCTION update_collaborations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_collaborations_updated_at
BEFORE UPDATE ON public.collaborations
FOR EACH ROW
EXECUTE FUNCTION update_collaborations_updated_at();

COMMENT ON FUNCTION update_collaborations_updated_at() IS 'Automatically updates updated_at timestamp when a collaboration record is modified';

