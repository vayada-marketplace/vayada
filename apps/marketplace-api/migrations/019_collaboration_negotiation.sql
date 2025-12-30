-- ============================================
-- MIGRATION: Collaboration Negotiation & Chat
-- ============================================

-- 1. Add Negotiation columns to collaborations table
ALTER TABLE public.collaborations
ADD COLUMN hotel_agreed_at timestamp with time zone,
ADD COLUMN creator_agreed_at timestamp with time zone,
ADD COLUMN term_last_updated_at timestamp with time zone DEFAULT now();

-- 2. Update Status Constraint to include 'negotiating'
-- Since it's a check constraint, we need to drop and re-add it
ALTER TABLE public.collaborations DROP CONSTRAINT IF EXISTS collaborators_status_check;
-- Also try dropping the default name just in case it wasn't named
ALTER TABLE public.collaborations DROP CONSTRAINT IF EXISTS collaborations_status_check;

ALTER TABLE public.collaborations
ADD CONSTRAINT collaborations_status_check 
CHECK (status IN ('pending', 'negotiating', 'accepted', 'declined', 'completed', 'cancelled'));

-- 3. Create Chat Messages table
CREATE TABLE public.chat_messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  collaboration_id uuid NOT NULL REFERENCES public.collaborations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES public.users(id) ON DELETE SET NULL, -- Nullable for System messages
  
  content text NOT NULL,
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'system')),
  metadata jsonb, -- For system messages (e.g. diffs)
  
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  read_at timestamp with time zone,
  
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id)
);

-- Indexes for chat
CREATE INDEX idx_chat_messages_collaboration_id ON public.chat_messages(collaboration_id);
CREATE INDEX idx_chat_messages_created_at ON public.chat_messages(created_at);

-- Comments
COMMENT ON TABLE public.chat_messages IS 'Chat history for collaborations. Includes system messages for audit trail.';
COMMENT ON COLUMN public.chat_messages.sender_id IS 'User who sent the message. NULL for system messages.';
COMMENT ON COLUMN public.chat_messages.metadata IS 'JSONB for extra data (e.g., {"old_date": "...", "new_date": "..."} to render rich system bubbles).';

-- 4. Update Collaborations Logic
-- Initialize negotiated terms with created_at
UPDATE public.collaborations 
SET term_last_updated_at = created_at 
WHERE term_last_updated_at IS NULL;
