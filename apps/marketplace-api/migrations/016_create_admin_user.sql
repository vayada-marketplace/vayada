-- ============================================
-- Create Admin User
-- ============================================
-- Creates the initial admin user for the platform
-- Password: Vayada123 (bcrypt hash)

-- Insert admin user if it doesn't exist
INSERT INTO users (email, password_hash, name, type, status, email_verified)
VALUES (
    'admin@vayada.com',
    '$2b$12$.sbVRdLMnCadYEkfLx1cJuxVbMT3ilI6ji5dcb2ZERVsH3vGGfOpG',
    'Admin User',
    'admin',
    'verified',
    true
)
ON CONFLICT (email) DO UPDATE
SET 
    type = 'admin',
    status = 'verified',
    password_hash = EXCLUDED.password_hash,
    updated_at = now();

-- Comments
COMMENT ON TABLE users IS 'Admin user created: admin@vayada.com';

