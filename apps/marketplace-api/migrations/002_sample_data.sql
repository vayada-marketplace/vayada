-- Sample data for hotels and creators
-- Note: Passwords are hashed with bcrypt. Default password for all test users: "password123"
-- Password hash: $2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82

-- Insert sample hotel users
INSERT INTO users (id, email, password_hash, name, type, status) VALUES
('11111111-1111-1111-1111-111111111111', 'grandhotel@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Grand Hotel Paris', 'hotel', 'verified'),
('22222222-2222-2222-2222-222222222222', 'seaside@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Seaside Resort', 'hotel', 'verified'),
('33333333-3333-3333-3333-333333333333', 'mountainlodge@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Mountain Lodge', 'hotel', 'verified'),
('44444444-4444-4444-4444-444444444444', 'citycenter@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'City Center Hotel', 'hotel', 'pending'),
('55555555-5555-5555-5555-555555555555', 'boutique@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Boutique Inn', 'hotel', 'verified')
ON CONFLICT (email) DO NOTHING;

-- Insert sample creator users
INSERT INTO users (id, email, password_hash, name, type, status) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'travelwanderer@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Travel Wanderer', 'creator', 'verified'),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'luxuryexplorer@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Luxury Explorer', 'creator', 'verified'),
('cccccccc-cccc-cccc-cccc-cccccccccccc', 'adventurejunkie@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Adventure Junkie', 'creator', 'verified'),
('dddddddd-dddd-dddd-dddd-dddddddddddd', 'budgettraveler@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Budget Traveler', 'creator', 'pending'),
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'foodietravels@example.com', '$2b$12$cSRROA06Oy88Q.ZatD7nCOF1Xcam5TcCdyB3QCw4L4o0MQWn5/B82', 'Foodie Travels', 'creator', 'verified')
ON CONFLICT (email) DO NOTHING;

-- Insert hotels
INSERT INTO hotels (id, user_id, name, location, description, images, amenities, status) VALUES
('11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Grand Hotel Paris', 'Paris, France', 
 'A luxurious 5-star hotel in the heart of Paris with stunning views of the Eiffel Tower. Experience world-class service and elegant accommodations.',
 ARRAY['https://images.unsplash.com/photo-1566073771259-6a8506099945', 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa'],
 ARRAY['Spa', 'Fine Dining', 'Rooftop Bar', 'Concierge', 'Valet Parking', 'Fitness Center'],
 'verified'),

('22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Seaside Resort', 'Bali, Indonesia',
 'A tropical paradise resort with private beach access, infinity pools, and world-renowned spa treatments. Perfect for relaxation and adventure.',
 ARRAY['https://images.unsplash.com/photo-1571896349842-33c89424de2d', 'https://images.unsplash.com/photo-1559827260-dc66d52bef19'],
 ARRAY['Beach Access', 'Infinity Pool', 'Spa', 'Water Sports', 'Restaurant', 'Kids Club'],
 'verified'),

('33333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'Mountain Lodge', 'Swiss Alps, Switzerland',
 'A cozy alpine lodge offering breathtaking mountain views, ski-in/ski-out access, and authentic Swiss hospitality.',
 ARRAY['https://images.unsplash.com/photo-1551632811-561732d1e306', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4'],
 ARRAY['Ski Access', 'Fireplace', 'Restaurant', 'Spa', 'Hiking Trails', 'Mountain Views'],
 'verified'),

('44444444-4444-4444-4444-444444444444', '44444444-4444-4444-4444-444444444444', 'City Center Hotel', 'New York, USA',
 'Modern hotel in the heart of Manhattan, steps away from Times Square and Broadway. Perfect for business and leisure travelers.',
 ARRAY['https://images.unsplash.com/photo-1564501049412-61c2a3083791', 'https://images.unsplash.com/photo-1520250497591-112f2f6a8413'],
 ARRAY['Business Center', 'Fitness Center', 'Restaurant', 'Bar', 'Concierge', 'WiFi'],
 'pending'),

('55555555-5555-5555-5555-555555555555', '55555555-5555-5555-5555-555555555555', 'Boutique Inn', 'Tuscany, Italy',
 'Charming boutique inn in the Italian countryside, surrounded by vineyards and olive groves. Experience authentic Italian culture.',
 ARRAY['https://images.unsplash.com/photo-1520250497591-112f2f6a8413', 'https://images.unsplash.com/photo-1566073771259-6a8506099945'],
 ARRAY['Wine Tasting', 'Garden', 'Restaurant', 'Pool', 'Bicycle Rental', 'Vineyard Tours'],
 'verified')
ON CONFLICT (id) DO NOTHING;

-- Insert creators
INSERT INTO creators (id, user_id, name, niche, audience_size, location, status) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Travel Wanderer', 
 ARRAY['Adventure Travel', 'Backpacking', 'Budget Travel'], 125000, 'Global Nomad', 'verified'),

('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Luxury Explorer',
 ARRAY['Luxury Travel', 'Fine Dining', 'Spa & Wellness'], 250000, 'New York, USA', 'verified'),

('cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Adventure Junkie',
 ARRAY['Extreme Sports', 'Mountain Climbing', 'Outdoor Adventure'], 180000, 'Colorado, USA', 'verified'),

('dddddddd-dddd-dddd-dddd-dddddddddddd', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'Budget Traveler',
 ARRAY['Budget Travel', 'Solo Travel', 'City Breaks'], 95000, 'London, UK', 'pending'),

('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Foodie Travels',
 ARRAY['Food & Dining', 'Culinary Travel', 'Local Cuisine'], 320000, 'San Francisco, USA', 'verified')
ON CONFLICT (id) DO NOTHING;

-- Insert creator platforms
INSERT INTO creator_platforms (id, creator_id, name, handle, followers, engagement_rate) VALUES
-- Travel Wanderer platforms
('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'instagram', '@travelwanderer', 85000, 4.2),
('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'youtube', '@travelwanderer', 40000, 3.8),

-- Luxury Explorer platforms
('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'instagram', '@luxuryexplorer', 150000, 5.1),
('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'tiktok', '@luxuryexplorer', 100000, 4.8),

-- Adventure Junkie platforms
('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'instagram', '@adventurejunkie', 120000, 4.5),
('c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'youtube', '@adventurejunkie', 60000, 4.2),

-- Budget Traveler platforms
('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'instagram', '@budgettraveler', 65000, 3.9),
('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'tiktok', '@budgettraveler', 30000, 4.1),

-- Foodie Travels platforms
('e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'instagram', '@foodietravels', 200000, 5.5),
('e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'youtube', '@foodietravels', 100000, 4.9),
('e3e3e3e3-e3e3-e3e3-e3e3-e3e3e3e3e3e3', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'tiktok', '@foodietravels', 20000, 4.3)
ON CONFLICT (id) DO NOTHING;

