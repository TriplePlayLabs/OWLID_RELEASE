-- Admin users for dashboard authentication
-- Uses bcrypt password hashing

CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_admin_users_username ON admin_users(username);

-- Default admin user (password: "admin" — CHANGE IN PRODUCTION)
-- bcrypt hash of "admin" with cost 12
INSERT INTO admin_users (username, password_hash)
VALUES ('admin', '$2b$12$itkrouQ3iK2yTbvQAyI2M.e/zULaT98vlcKnJ8lF.K0cMq86eISzW')
ON CONFLICT (username) DO NOTHING;

COMMENT ON TABLE admin_users IS 'Admin dashboard users with bcrypt password authentication';
