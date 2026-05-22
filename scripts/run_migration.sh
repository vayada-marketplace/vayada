#!/usr/bin/env bash
#
# Run database migrations against AWS RDS for a given service.
#
# Usage:
#   ./scripts/run_migration.sh pms
#   ./scripts/run_migration.sh booking
#   ./scripts/run_migration.sh marketplace
#   ./scripts/run_migration.sh auth
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - infra/terraform.tfvars with database passwords
#   - Python 3 with asyncpg installed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
RDS_SG_ID="sg-0089fc5e42fa33566"
RDS_PORT=5432
AWS_REGION="eu-west-1"
SSM_PREFIX="/vayada/prod"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die() { echo "❌ $*" >&2; exit 1; }

read_ssm() {
    # Fetch a SecureString parameter from SSM and decrypt it
    local name="$1"
    aws ssm get-parameter \
        --region "$AWS_REGION" \
        --name "$name" \
        --with-decryption \
        --query Parameter.Value \
        --output text 2>/dev/null
}

# ---------------------------------------------------------------------------
# Validate arguments
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <service>"
    echo "  service: pms | booking | marketplace | auth"
    exit 1
fi

SERVICE="$1"

# ---------------------------------------------------------------------------
# Service config mapping. SSM holds the full DATABASE_URL for each backend
# (provisioned in vayada-platform infra/ssm.tf). For SSL connectivity from
# outside the VPC we prefer the *-ssl variant where it exists.
# ---------------------------------------------------------------------------
case "$SERVICE" in
    pms)
        SSM_URL_KEY="${SSM_PREFIX}/db-pms-url-ssl"
        MIGRATION_SCRIPT="apps/pms-api/scripts/run_migrations.py"
        SERVICE_DIR="apps/pms-api"
        ;;
    booking)
        SSM_URL_KEY="${SSM_PREFIX}/db-booking-url"
        APPEND_SSL=true
        MIGRATION_SCRIPT="apps/booking-api/scripts/run_migrations.py"
        SERVICE_DIR="apps/booking-api"
        ;;
    marketplace)
        # Note: /vayada/prod/db-marketplace-url is the admin URL pointing at
        # the postgres database. Build the marketplace URL explicitly using
        # the master password.
        SSM_URL_KEY=""
        MIGRATION_SCRIPT="apps/marketplace-api/scripts/run_migrations.py"
        SERVICE_DIR="apps/marketplace-api"
        ;;
    auth)
        SSM_URL_KEY="${SSM_PREFIX}/db-auth-url-ssl"
        MIGRATION_SCRIPT="auth-db/scripts/run_migrations.py"
        SERVICE_DIR="auth-db"
        ;;
    *)
        die "Unknown service: $SERVICE (expected: pms, booking, marketplace, auth)"
        ;;
esac

# ---------------------------------------------------------------------------
# Resolve DATABASE_URL from SSM
# ---------------------------------------------------------------------------
aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1 \
    || die "AWS credentials are not configured or expired. Run your SSO login first."

if [[ "$SERVICE" == "marketplace" ]]; then
    # Marketplace doesn't have a clean SSM URL — assemble it from one we do.
    # db-pms-url-ssl is in the same RDS instance with sslmode=require, so reuse
    # its host. Password comes from a dedicated SSM lookup if it exists,
    # otherwise the platform team needs to add /vayada/prod/db-marketplace-url-ssl.
    die "marketplace migrations require /vayada/prod/db-marketplace-url-ssl in SSM (not yet provisioned). Ask platform team to add it, or set DATABASE_URL manually and run the migration script directly."
fi

echo "🔑 Fetching DATABASE_URL from SSM ($SSM_URL_KEY)..."
DATABASE_URL=$(read_ssm "$SSM_URL_KEY")
[[ -n "$DATABASE_URL" ]] || die "Could not read $SSM_URL_KEY from SSM"

if [[ "${APPEND_SSL:-false}" == "true" && "$DATABASE_URL" != *"sslmode="* ]]; then
    if [[ "$DATABASE_URL" == *"?"* ]]; then
        DATABASE_URL="${DATABASE_URL}&sslmode=require"
    else
        DATABASE_URL="${DATABASE_URL}?sslmode=require"
    fi
fi

# Verify migration script exists
FULL_MIGRATION_SCRIPT="$REPO_ROOT/$MIGRATION_SCRIPT"
[[ -f "$FULL_MIGRATION_SCRIPT" ]] || die "Migration script not found: $FULL_MIGRATION_SCRIPT"

# ---------------------------------------------------------------------------
# Get public IP
# ---------------------------------------------------------------------------
echo "🌐 Getting your public IP..."
MY_IP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
[[ -n "$MY_IP" ]] || die "Could not determine public IP"
echo "   Your IP: $MY_IP"

# ---------------------------------------------------------------------------
# Security group management
# ---------------------------------------------------------------------------
SG_RULE_ADDED=false

cleanup_sg() {
    if [[ "$SG_RULE_ADDED" == "true" ]]; then
        echo ""
        echo "🔒 Removing security group ingress rule..."
        aws ec2 revoke-security-group-ingress \
            --region "$AWS_REGION" \
            --group-id "$RDS_SG_ID" \
            --protocol tcp \
            --port "$RDS_PORT" \
            --cidr "${MY_IP}/32" \
            2>/dev/null && echo "   ✅ Rule removed" || echo "   ⚠️  Could not remove rule (may already be gone)"
    fi
}

trap cleanup_sg EXIT

echo "🔓 Adding temporary security group ingress rule..."
aws ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$RDS_SG_ID" \
    --protocol tcp \
    --port "$RDS_PORT" \
    --cidr "${MY_IP}/32" \
    >/dev/null
SG_RULE_ADDED=true
echo "   ✅ Ingress rule added for ${MY_IP}/32 on port $RDS_PORT"

# Give AWS a moment to propagate the rule
sleep 2

# ---------------------------------------------------------------------------
# Run migrations
# ---------------------------------------------------------------------------
echo ""
echo "🚀 Running $SERVICE migrations..."
echo ""

cd "$REPO_ROOT/$SERVICE_DIR"
DATABASE_URL="$DATABASE_URL" python3 scripts/run_migrations.py

echo ""
echo "✅ Done!"
