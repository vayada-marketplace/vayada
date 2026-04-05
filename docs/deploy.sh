#!/bin/bash
set -e

echo "Building docs..."
cd "$(dirname "$0")"
npm run build

echo "Syncing to S3..."
aws s3 sync build/ s3://vayada-docs --delete

echo "Invalidating CloudFront cache..."
DISTRIBUTION_ID=$(cd ../infra && terraform output -raw docs_cloudfront_distribution_id)
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"

echo "Done! Docs will be live at https://docs.vayada.com in a few minutes."
