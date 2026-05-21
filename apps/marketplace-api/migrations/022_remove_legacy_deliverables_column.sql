-- ============================================
-- Remove platform_deliverables (JSONB) from collaborations
-- ============================================
-- The platform_deliverables column has been replaced by the 
-- collaboration_deliverables table for better normalization.

-- Check if the column exists before dropping (optional safety check)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'collaborations' 
        AND column_name = 'platform_deliverables'
    ) THEN
        ALTER TABLE public.collaborations DROP COLUMN platform_deliverables;
    END IF;
END $$;
