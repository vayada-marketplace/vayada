-- ============================================
-- Migration 031: Create trips and external_collaborations tables
-- ============================================

-- ============================================
-- TRIPS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location TEXT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT chk_trips_end_date CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_trips_creator_id ON public.trips(creator_id);

COMMENT ON TABLE public.trips IS 'Creator trips - a creator registers an upcoming trip with dates and location';

-- ============================================
-- EXTERNAL COLLABORATIONS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS public.external_collaborations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID NOT NULL REFERENCES public.creators(id) ON DELETE CASCADE,
    trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    hotel_name TEXT,
    location TEXT,
    collaboration_type TEXT CHECK (collaboration_type IN ('Custom / External', 'Paid', 'Free Stay')),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    deliverables TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT chk_external_collaborations_end_date CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_external_collaborations_creator_id ON public.external_collaborations(creator_id);
CREATE INDEX IF NOT EXISTS idx_external_collaborations_trip_id ON public.external_collaborations(trip_id);

COMMENT ON TABLE public.external_collaborations IS 'Collaborations with hotels not on the platform, optionally linked to a trip';

-- ============================================
-- TRIGGER: Update updated_at timestamp for trips
-- ============================================

CREATE OR REPLACE FUNCTION update_trips_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_trips_updated_at
BEFORE UPDATE ON public.trips
FOR EACH ROW
EXECUTE FUNCTION update_trips_updated_at();

COMMENT ON FUNCTION update_trips_updated_at() IS 'Automatically updates updated_at timestamp when a trip record is modified';

-- ============================================
-- TRIGGER: Update updated_at timestamp for external_collaborations
-- ============================================

CREATE OR REPLACE FUNCTION update_external_collaborations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_external_collaborations_updated_at
BEFORE UPDATE ON public.external_collaborations
FOR EACH ROW
EXECUTE FUNCTION update_external_collaborations_updated_at();

COMMENT ON FUNCTION update_external_collaborations_updated_at() IS 'Automatically updates updated_at timestamp when an external collaboration record is modified';
