-- Sample user data
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

