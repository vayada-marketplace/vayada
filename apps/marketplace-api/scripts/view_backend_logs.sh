#!/bin/bash

# Script to view backend logs from CloudWatch
# Usage: ./scripts/view_backend_logs.sh [--tail] [--follow] [--lines N]

set -e

CLUSTER_NAME="vayada-backend-cluster"
LOG_GROUP="/ecs/vayada-backend"
AWS_REGION="eu-west-1"
LINES=${1:-50}

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo "❌ AWS credentials not configured. Please run 'aws configure' or 'aws login'"
    exit 1
fi

echo "📋 Fetching logs from CloudWatch..."
echo "   Log Group: $LOG_GROUP"
echo "   Region: $AWS_REGION"
echo ""

# Get the most recent log stream
LATEST_STREAM=$(aws logs describe-log-streams \
    --log-group-name "$LOG_GROUP" \
    --region "$AWS_REGION" \
    --order-by LastEventTime \
    --descending \
    --max-items 1 \
    --query 'logStreams[0].logStreamName' \
    --output text 2>/dev/null)

if [ -z "$LATEST_STREAM" ] || [ "$LATEST_STREAM" == "None" ]; then
    echo "❌ No log streams found in $LOG_GROUP"
    echo ""
    echo "Available log groups:"
    aws logs describe-log-groups --region "$AWS_REGION" --query 'logGroups[*].logGroupName' --output table
    exit 1
fi

echo "📊 Latest log stream: $LATEST_STREAM"
echo ""

# Get log events
if [ "$1" == "--follow" ] || [ "$1" == "-f" ]; then
    echo "🔄 Following logs (Ctrl+C to stop)..."
    echo ""
    aws logs tail "$LOG_GROUP" \
        --region "$AWS_REGION" \
        --follow \
        --format short
else
    # Get last N lines
    LINES=${LINES//--lines=/}
    LINES=${LINES//-n/}
    LINES=${LINES:-50}
    
    echo "📄 Last $LINES log entries:"
    echo ""
    
    aws logs get-log-events \
        --log-group-name "$LOG_GROUP" \
        --log-stream-name "$LATEST_STREAM" \
        --region "$AWS_REGION" \
        --limit "$LINES" \
        --query 'events[*].[timestamp,message]' \
        --output text | \
    while IFS=$'\t' read -r timestamp message; do
        # Convert timestamp to readable date
        date_str=$(date -r $((timestamp / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$timestamp")
        echo "[$date_str] $message"
    done
fi

