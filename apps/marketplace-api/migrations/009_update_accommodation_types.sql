-- ============================================
-- Update accommodation_type allowed values
-- ============================================
-- Remove 'Lodge', add 'Luxury Hotel' and 'City Hotel'
-- New allowed values: Hotel, Resort, Boutique Hotel, Luxury Hotel, City Hotel, Apartment, Villa

-- Drop the existing CHECK constraint
ALTER TABLE public.hotel_listings
DROP CONSTRAINT IF EXISTS hotel_listings_accommodation_type_check;

-- Add new CHECK constraint with updated values
ALTER TABLE public.hotel_listings
ADD CONSTRAINT hotel_listings_accommodation_type_check 
CHECK (accommodation_type IS NULL OR accommodation_type IN (
  'Hotel', 'Resort', 'Boutique Hotel', 'Luxury Hotel', 'City Hotel', 'Apartment', 'Villa'
));

