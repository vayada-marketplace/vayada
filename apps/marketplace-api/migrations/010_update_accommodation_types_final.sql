-- ============================================
-- Update accommodation_type allowed values (Final)
-- ============================================
-- Final allowed values: Hotel, Boutiques Hotel, City Hotel, Luxury Hotel, Apartment, Villa, Lodge
-- Changes from previous:
--   - Changed: Boutique Hotel -> Boutiques Hotel
--   - Removed: Resort (will be updated to Hotel)
--   - Added: Lodge

-- Step 1: Update existing data to match new values
-- Update "Boutique Hotel" to "Boutiques Hotel"
UPDATE public.hotel_listings
SET accommodation_type = 'Boutiques Hotel'
WHERE accommodation_type = 'Boutique Hotel';

-- Update "Resort" to "Hotel" (since Resort is being removed)
UPDATE public.hotel_listings
SET accommodation_type = 'Hotel'
WHERE accommodation_type = 'Resort';

-- Step 2: Drop the existing CHECK constraint
ALTER TABLE public.hotel_listings
DROP CONSTRAINT IF EXISTS hotel_listings_accommodation_type_check;

-- Step 3: Add new CHECK constraint with final values
ALTER TABLE public.hotel_listings
ADD CONSTRAINT hotel_listings_accommodation_type_check 
CHECK (accommodation_type IS NULL OR accommodation_type IN (
  'Hotel', 'Boutiques Hotel', 'City Hotel', 'Luxury Hotel', 'Apartment', 'Villa', 'Lodge'
));

