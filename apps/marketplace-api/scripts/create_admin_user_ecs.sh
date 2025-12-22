#!/bin/bash

# Create admin user as an ECS one-off task
# This uses the same task definition but overrides the command to create admin user

set -e

CLUSTER_NAME="vayada-backend-cluster"
TASK_DEFINITION="vayada-backend-task"
AWS_REGION="eu-west-1"
SUBNET_IDS="subnet-0f5978ad929071531,subnet-0cebe0311f380e8e6"
SECURITY_GROUP="sg-0089fc5e42fa33566"

EMAIL="admin@vayada.com"
PASSWORD="Vayada123"
NAME="Admin User"

echo "🚀 Creating admin user as ECS task..."
echo "   Email: $EMAIL"
echo "   Cluster: $CLUSTER_NAME"
echo "   Task Definition: $TASK_DEFINITION"
echo ""

# Get the latest task definition
LATEST_TASK_DEF=$(aws ecs describe-task-definition \
    --task-definition $TASK_DEFINITION \
    --region $AWS_REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo "📋 Using task definition: $LATEST_TASK_DEF"
echo ""

# Run the task with overridden command to create admin user
echo "🚀 Starting admin user creation task..."
TASK_ARN=$(aws ecs run-task \
    --cluster $CLUSTER_NAME \
    --task-definition $TASK_DEFINITION \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
    --overrides "{
        \"containerOverrides\": [{
            \"name\": \"vayada-backend\",
            \"command\": [\"sh\", \"-c\", \"cd /app && PYTHONPATH=/app python3 scripts/create_admin_user.py\"],
            \"environment\": [
                {\"name\": \"ADMIN_EMAIL\", \"value\": \"$EMAIL\"},
                {\"name\": \"ADMIN_PASSWORD\", \"value\": \"$PASSWORD\"},
                {\"name\": \"ADMIN_NAME\", \"value\": \"$NAME\"}
            ]
        }]
    }" \
    --region $AWS_REGION \
    --query 'tasks[0].taskArn' \
    --output text)

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" == "None" ]; then
    echo "❌ Failed to start task"
    exit 1
fi

echo "✅ Task started: $TASK_ARN"
echo ""
echo "📊 Monitoring task status..."
echo "   (This may take a minute)"
echo ""

# Wait for task to complete
TASK_ID=$(echo $TASK_ARN | awk -F/ '{print $NF}')
MAX_WAIT=300  # 5 minutes
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
            echo ""
            echo "✅ Task completed successfully!"
            
            # Get logs
            echo ""
            echo "📋 Task logs:"
            LOG_GROUP="/ecs/vayada-backend"
            LOG_STREAM="ecs/vayada-backend/$TASK_ID"
            
            aws logs get-log-events \
                --log-group-name $LOG_GROUP \
                --log-stream-name $LOG_STREAM \
                --region $AWS_REGION \
                --query 'events[*].message' \
                --output text 2>/dev/null | tail -30 || echo "   (Logs not available)"
            
            exit 0
        else
            echo ""
            echo "❌ Task failed with exit code: $EXIT_CODE"
            
            # Get logs
            echo ""
            echo "📋 Task logs:"
            LOG_GROUP="/ecs/vayada-backend"
            LOG_STREAM="ecs/vayada-backend/$TASK_ID"
            
            aws logs get-log-events \
                --log-group-name $LOG_GROUP \
                --log-stream-name $LOG_STREAM \
                --region $AWS_REGION \
                --query 'events[*].message' \
                --output text 2>/dev/null | tail -30 || echo "   (Logs not available)"
            
            exit 1
        fi
    elif [ "$STATUS" == "RUNNING" ]; then
        echo "   ⏳ Task is running... (${ELAPSED}s elapsed)"
    fi
    
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

echo ""
echo "⏱️  Task is taking longer than expected. Check status manually:"
echo "   aws ecs describe-tasks --cluster $CLUSTER_NAME --tasks $TASK_ARN --region $AWS_REGION"
exit 1

