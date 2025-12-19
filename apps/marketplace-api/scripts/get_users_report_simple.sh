#!/bin/bash

# Simple script to get users report from AWS
# This script checks AWS authentication and runs the export on ECS

set -e

echo "🔍 Checking AWS authentication..."

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo "❌ AWS CLI is not installed"
    echo "   Install it with: brew install awscli"
    exit 1
fi

# Check AWS authentication
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS session expired or not authenticated"
    echo ""
    echo "Please authenticate with AWS:"
    echo "   aws sso login"
    echo "   or"
    echo "   aws login"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo "✅ AWS authenticated"
echo ""

# Run the main script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/get_users_report.sh"

