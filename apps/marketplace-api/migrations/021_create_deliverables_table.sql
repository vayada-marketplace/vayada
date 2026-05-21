-- ============================================
-- MIGRATION: Collaboration Deliverables Table
-- ============================================

-- 1. Create the collaboration_deliverables table
CREATE TABLE public.collaboration_deliverables (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  collaboration_id uuid NOT NULL REFERENCES public.collaborations(id) ON DELETE CASCADE,
  
  -- Platform can be social media or other types
  platform text NOT NULL, -- Instagram, TikTok, YouTube, Facebook, Content Package, Custom
  
  -- Deliverable details
  type text NOT NULL, -- e.g., "Instagram Post", "Instagram Stories", "Photos", "Drone Footage"
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  
  -- Progress tracking
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT collaboration_deliverables_pkey PRIMARY KEY (id)
);

-- 2. Indexes for performance
CREATE INDEX idx_collaboration_deliverables_collab_id ON public.collaboration_deliverables(collaboration_id);
CREATE INDEX idx_collaboration_deliverables_status ON public.collaboration_deliverables(status);
CREATE INDEX idx_collaboration_deliverables_platform ON public.collaboration_deliverables(platform);

-- 3. Data Migration
-- Migrates existing jsonb data from collaborations table to the new table
DO $$
DECLARE
    collab_record RECORD;
    deliverable_item JSONB;
    platform_item JSONB;
BEGIN
    FOR collab_record IN SELECT id, platform_deliverables FROM public.collaborations LOOP
        IF jsonb_array_length(collab_record.platform_deliverables) > 0 THEN
            FOR platform_item IN SELECT * FROM jsonb_array_elements(collab_record.platform_deliverables) LOOP
                FOR deliverable_item IN SELECT * FROM jsonb_array_elements(platform_item->'deliverables') LOOP
                    INSERT INTO public.collaboration_deliverables (
                        collaboration_id,
                        platform,
                        type,
                        quantity,
                        status,
                        created_at
                    ) VALUES (
                        collab_record.id,
                        COALESCE(platform_item->>'platform', 'Custom'),
                        COALESCE(deliverable_item->>'type', 'Unknown'),
                        COALESCE((deliverable_item->>'quantity')::integer, 1),
                        CASE 
                            WHEN (deliverable_item->>'completed')::boolean = true THEN 'completed'
                            ELSE 'pending'
                        END,
                        COALESCE((deliverable_item->>'created_at')::timestamp with time zone, now())
                    );
                END LOOP;
            END LOOP;
        END IF;
    END LOOP;
END $$;

-- 4. Comments
COMMENT ON TABLE public.collaboration_deliverables IS 'Individual deliverables for a collaboration, allowing status tracking per item.';
COMMENT ON COLUMN public.collaboration_deliverables.platform IS 'Platform for the deliverable: Instagram, TikTok, YouTube, Facebook, Content Package, Custom';
COMMENT ON COLUMN public.collaboration_deliverables.status IS 'Status of the deliverable: pending, completed';

-- 5. Trigger for updated_at
CREATE TRIGGER trigger_update_collaboration_deliverables_updated_at
BEFORE UPDATE ON public.collaboration_deliverables
FOR EACH ROW
EXECUTE FUNCTION update_collaborations_updated_at();
