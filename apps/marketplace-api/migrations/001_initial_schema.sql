-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (authentication + profile information)
CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['hotel'::text, 'creator'::text, 'admin'::text])),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'suspended'::text])),
  avatar text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- Hotels table
CREATE TABLE public.hotels (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  location text NOT NULL,
  description text,
  images text[] DEFAULT '{}'::text[],
  amenities text[] DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'suspended'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hotels_pkey PRIMARY KEY (id),
  CONSTRAINT hotels_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Creators table
CREATE TABLE public.creators (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  niche text[] DEFAULT '{}'::text[],
  audience_size integer DEFAULT 0,
  location text,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'suspended'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creators_pkey PRIMARY KEY (id),
  CONSTRAINT creators_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Creator platforms table
CREATE TABLE public.creator_platforms (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  creator_id uuid NOT NULL,
  name text NOT NULL CHECK (name = ANY (ARRAY['instagram'::text, 'tiktok'::text, 'youtube'::text, 'twitter'::text, 'facebook'::text, 'linkedin'::text, 'other'::text])),
  handle text NOT NULL,
  followers integer DEFAULT 0,
  engagement_rate numeric DEFAULT 0.00,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT creator_platforms_pkey PRIMARY KEY (id),
  CONSTRAINT creator_platforms_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.creators(id) ON DELETE CASCADE
);

-- Collaborations table
CREATE TABLE public.collaborations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  hotel_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'completed'::text, 'cancelled'::text])),
  message text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT collaborations_pkey PRIMARY KEY (id),
  CONSTRAINT collaborations_hotel_id_fkey FOREIGN KEY (hotel_id) REFERENCES public.hotels(id) ON DELETE CASCADE,
  CONSTRAINT collaborations_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.creators(id) ON DELETE CASCADE
);

-- Messages table
CREATE TABLE public.messages (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  collaboration_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  content text NOT NULL,
  read_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_collaboration_id_fkey FOREIGN KEY (collaboration_id) REFERENCES public.collaborations(id) ON DELETE CASCADE,
  CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES public.users(id) ON DELETE CASCADE
);

-- Create indexes for better query performance
CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_type ON public.users(type);
CREATE INDEX idx_users_status ON public.users(status);
CREATE INDEX idx_hotels_user_id ON public.hotels(user_id);
CREATE INDEX idx_hotels_status ON public.hotels(status);
CREATE INDEX idx_creators_user_id ON public.creators(user_id);
CREATE INDEX idx_creators_status ON public.creators(status);
CREATE INDEX idx_creator_platforms_creator_id ON public.creator_platforms(creator_id);
CREATE INDEX idx_collaborations_hotel_id ON public.collaborations(hotel_id);
CREATE INDEX idx_collaborations_creator_id ON public.collaborations(creator_id);
CREATE INDEX idx_collaborations_status ON public.collaborations(status);
CREATE INDEX idx_collaborations_hotel_creator ON public.collaborations(hotel_id, creator_id);
CREATE INDEX idx_messages_collaboration_id ON public.messages(collaboration_id);
CREATE INDEX idx_messages_sender_id ON public.messages(sender_id);
CREATE INDEX idx_messages_receiver_id ON public.messages(receiver_id);
CREATE INDEX idx_messages_created_at ON public.messages(created_at);

