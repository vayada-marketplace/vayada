-- ============================================
-- Update accommodation_type allowed values
-- ============================================
-- New allowed values: Hotel, Boutiques Hotel, City Hotel, Luxury Hotel, Apartment, Villa, Lodge
-- Removed: Resort
-- Changed: Boutique Hotel -> Boutiques Hotel
-- Added: City Hotel, Luxury Hotel

-- Drop the existing CHECK constraint
ALTER TABLE public.hotel_listings
DROP CONSTRAINT IF EXISTS hotel_listings_accommodation_type_check;

-- Add new CHECK constraint with updated values
ALTER TABLE public.hotel_listings
ADD CONSTRAINT hotel_listings_accommodation_type_check 
CHECK (accommodation_type IS NULL OR accommodation_type IN (
  'Hotel', 'Boutiques Hotel', 'City Hotel', 'Luxury Hotel', 'Apartment', 'Villa', 'Lodge'
));

