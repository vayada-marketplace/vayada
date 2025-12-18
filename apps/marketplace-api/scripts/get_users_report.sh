#!/bin/bash

# Complete script to get users report from AWS and save as HTML
# This script:
# 1. Runs the export task on ECS
# 2. Waits for completion
# 3. Extracts the HTML from logs
# 4. Decodes and saves it to a file

set -e

CLUSTER_NAME="vayada-backend-cluster"
TASK_DEFINITION="vayada-backend-task"
AWS_REGION="eu-west-1"
SUBNET_IDS="subnet-0f5978ad929071531,subnet-0cebe0311f380e8e6"
SECURITY_GROUP="sg-0089fc5e42fa33566"
LOG_GROUP="/ecs/vayada-backend"

echo "🚀 Starting users report export..."
echo ""

# Step 1: Run the export task
echo "📊 Step 1: Running export task on ECS..."
LATEST_TASK_DEF=$(aws ecs describe-task-definition \
    --task-definition $TASK_DEFINITION \
    --region $AWS_REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

TASK_ARN=$(aws ecs run-task \
    --cluster $CLUSTER_NAME \
    --task-definition $TASK_DEFINITION \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
    --overrides "{
        \"containerOverrides\": [{
            \"name\": \"vayada-backend\",
            \"command\": [\"sh\", \"-c\", \"cd /app && PYTHONPATH=/app python3 scripts/export_users_report.py\"]
        }]
    }" \
    --region $AWS_REGION \
    --query 'tasks[0].taskArn' \
    --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" == "None" ]; then
    echo "❌ Failed to start task"
    exit 1
fi

TASK_ID=$(echo $TASK_ARN | awk -F/ '{print $NF}')
LOG_STREAM="ecs/vayada-backend/$TASK_ID"

echo "✅ Task started: $TASK_ID"
echo "⏳ Waiting for task to complete..."
echo ""

# Step 2: Wait for task to complete
MAX_WAIT=300
ELAPSED=0
INTERVAL=10

while [ $ELAPSED -lt $MAX_WAIT ]; do
    STATUS=$(aws ecs describe-tasks \
        --cluster $CLUSTER_NAME \
        --tasks $TASK_ARN \
        --region $AWS_REGION \
        --query 'tasks[0].lastStatus' \
        --output text 2>/dev/null || echo "UNKNOWN")
    
    if [ "$STATUS" == "STOPPED" ]; then
        EXIT_CODE=$(aws ecs describe-tasks \
            --cluster $CLUSTER_NAME \
            --tasks $TASK_ARN \
            --region $AWS_REGION \
            --query 'tasks[0].containers[0].exitCode' \
            --output text 2>/dev/null || echo "1")
        
        if [ "$EXIT_CODE" == "0" ]; then
            echo "✅ Task completed successfully!"
            break
        else
            echo "❌ Task failed with exit code: $EXIT_CODE"
            exit 1
        fi
    fi
    
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

if [ "$STATUS" != "STOPPED" ]; then
    echo "⏱️  Task timeout. Trying to extract report anyway..."
fi

# Step 3: Extract HTML from logs
echo ""
echo "📋 Step 2: Extracting HTML report from logs..."

# Wait a bit for logs to be available
sleep 5

# Get all log events
LOG_OUTPUT=$(aws logs get-log-events \
    --log-group-name $LOG_GROUP \
    --log-stream-name $LOG_STREAM \
    --region $AWS_REGION \
    --query 'events[*].message' \
    --output text 2>/dev/null || echo "")

if [ -z "$LOG_OUTPUT" ]; then
    echo "❌ Could not retrieve logs. Please try again in a few moments."
    exit 1
fi

# Extract base64 string (between the === markers)
# Method 1: Extract between the === markers
B64_STRING=$(echo "$LOG_OUTPUT" | \
    awk '
    /HTML Report \(Base64/ { start=1; next }
    start && /^===/ { in_b64=1; next }
    in_b64 && /^===/ { exit }
    in_b64 && !/To decode/ { print }
    ' | \
    tr -d '\n\r' | \
    sed 's/[[:space:]]//g')

if [ -z "$B64_STRING" ] || [ ${#B64_STRING} -lt 100 ]; then
    echo "💡 Trying alternative extraction method..."
    
    # Method 2: Extract everything after the marker line
    B64_STRING=$(echo "$LOG_OUTPUT" | \
        sed -n '/HTML Report (Base64/,/^===/p' | \
        sed '1d;$d' | \
        grep -v "To decode" | \
        tr -d '\n\r' | \
        sed 's/[[:space:]]//g')
fi

if [ -z "$B64_STRING" ] || [ ${#B64_STRING} -lt 100 ]; then
    echo "💡 Trying method 3: Extract longest base64-like string..."
    
    # Method 3: Find the longest base64-like string in logs
    B64_STRING=$(echo "$LOG_OUTPUT" | \
        grep -oE '[A-Za-z0-9+/]{100,}={0,2}' | \
        sort -r | \
        head -1)
fi

if [ -z "$B64_STRING" ] || [ ${#B64_STRING} -lt 100 ]; then
    echo "❌ Could not extract valid base64 string"
    echo "📋 Showing last 20 lines of logs for debugging:"
    echo "$LOG_OUTPUT" | tail -20
    exit 1
fi

# Step 4: Decode and save
echo "💾 Step 3: Decoding and saving HTML report..."

OUTPUT_FILE="users_report_$(date +%Y%m%d_%H%M%S).html"

# Decode base64 and save
echo "$B64_STRING" | base64 -d > "$OUTPUT_FILE" 2>/dev/null

if [ $? -eq 0 ] && [ -f "$OUTPUT_FILE" ] && [ -s "$OUTPUT_FILE" ]; then
    FILE_SIZE=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
    echo ""
    echo "✅ Success! HTML report saved to: $OUTPUT_FILE"
    echo "   File size: $FILE_SIZE bytes"
    echo ""
    echo "💡 Open $OUTPUT_FILE in your browser to view the beautiful report!"
    echo ""
    
    # Also create a symlink for easy access
    ln -sf "$OUTPUT_FILE" users_report_latest.html 2>/dev/null || true
    echo "📌 Also available as: users_report_latest.html"
else
    echo "❌ Failed to decode or save HTML file"
    echo "💡 Base64 string length: ${#B64_STRING}"
    exit 1
fi

