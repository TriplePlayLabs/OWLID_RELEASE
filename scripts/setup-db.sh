#!/bin/bash
set -e

echo "=== OwlID Database Setup ==="
echo ""

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "Error: docker-compose is not installed"
    exit 1
fi

# Check if .env exists, if not copy from example
if [ ! -f .env ]; then
    echo "Creating .env file from .env.example..."
    cp .env.example .env
    echo "✅ .env file created"
else
    echo "✅ .env file already exists"
fi

# Start PostgreSQL
echo ""
echo "Starting PostgreSQL..."
docker-compose up -d postgres

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U owl &> /dev/null; then
        echo "✅ PostgreSQL is ready"
        break
    fi
    echo -n "."
    sleep 1
done

# Run migrations
echo ""
echo "Running database migrations..."
docker-compose up migrator

# Check if migrations succeeded
if [ $? -eq 0 ]; then
    echo "✅ Migrations completed successfully"
else
    echo "❌ Migrations failed"
    exit 1
fi

# Verify database setup
echo ""
echo "Verifying database setup..."
docker-compose exec -T postgres psql -U owl -d owl_identity -c "\dt" > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ Database verification successful"
else
    echo "❌ Database verification failed"
    exit 1
fi

# Create development API key
echo ""
echo "Setting up development API key..."
echo "API Key: dev_key_12345678901234567890123456789012"
echo ""

echo "=== Setup Complete! ==="
echo ""
echo "Database URL: postgres://owl:owl_password@localhost:5432/owl_identity"
echo "Dev API Key: dev_key_12345678901234567890123456789012"
echo ""
echo "Next steps:"
echo "  1. cargo run -p owl-verification-service"
echo "  2. Use the API key in X-API-Key header"
echo ""
