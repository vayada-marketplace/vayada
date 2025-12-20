#!/bin/bash

# Simple deployment script - run after AWS authentication
# Usage: ./scripts/deploy-simple.sh [--deploy]

set -e

AWS_REGION="eu-west-1"
ECR_REPOSITORY="vayada-creator-marketplace-backend"
AWS_ACCOUNT_ID="269416271598"
IMAGE_NAME="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
IMAGE_TAG="${TIMESTAMP}-${GIT_SHA}"

echo "🚀 Building and pushing Docker image..."
echo "   Tag: ${IMAGE_TAG}"
echo "   Latest: latest"

# Login to ECR
aws ecr get-login-password --region ${AWS_REGION} | \
    docker login --username AWS --password-stdin ${IMAGE_NAME}

# Set up buildx builder if it doesn't exist
if ! docker buildx ls | grep -q "multiarch"; then
    echo "   Setting up buildx builder..."
    docker buildx create --name multiarch --use 2>/dev/null || docker buildx use multiarch
    docker buildx inspect --bootstrap
fi

# Build and push for linux/amd64 (required for ECS Fargate)
echo "   Building for linux/amd64 platform..."
docker buildx build --platform linux/amd64 \
    -t ${IMAGE_NAME}:${IMAGE_TAG} \
    -t ${IMAGE_NAME}:latest \
    --push .

echo "✅ Image pushed successfully!"
echo "   ${IMAGE_NAME}:${IMAGE_TAG}"
echo "   ${IMAGE_NAME}:latest"

# Deploy if requested
if [ "$1" == "--deploy" ]; then
    echo ""
    echo "📦 Deploying to cluster..."
    
    # Try EKS
    if command -v kubectl &> /dev/null && kubectl get deployment vayada-backend &> /dev/null 2>&1; then
        echo "   Updating Kubernetes deployment..."
        kubectl set image deployment/vayada-backend backend=${IMAGE_NAME}:${IMAGE_TAG}
        kubectl rollout status deployment/vayada-backend
        echo "✅ Deployment complete!"
    # Try ECS
    elif command -v aws &> /dev/null; then
        echo "   Deploying to ECS..."
        CLUSTER_NAME="vayada-backend-cluster"
        SERVICE_NAME="vayada-backend-service"
        
        if aws ecs describe-services --cluster ${CLUSTER_NAME} --services ${SERVICE_NAME} --region ${AWS_REGION} &> /dev/null; then
            aws ecs update-service \
                --cluster ${CLUSTER_NAME} \
                --service ${SERVICE_NAME} \
                --force-new-deployment \
                --region ${AWS_REGION} \
                --output json > /dev/null
            
            echo "✅ ECS deployment triggered!"
            echo "   Cluster: ${CLUSTER_NAME}"
            echo "   Service: ${SERVICE_NAME}"
            echo "   Deployment in progress..."
        else
            echo "   ECS service not found. Please deploy manually."
        fi
    else
        echo "   Please deploy manually using AWS Console or CLI"
    fi
fi

echo ""
echo "✨ Done!"

