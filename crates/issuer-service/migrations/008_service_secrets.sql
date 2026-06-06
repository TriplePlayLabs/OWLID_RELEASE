CREATE TABLE service_secrets (
    name VARCHAR(80) PRIMARY KEY,
    secret_hex TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
