#!/bin/bash

# Deployment script for Vayada Creator Marketplace Backend
# This script builds the Docker image, pushes it to ECR, and optionally deploys to a cluster

set -e  # Exit on error

# Configuration
AWS_REGION="eu-west-1"
ECR_REPOSITORY="vayada-creator-marketplace-backend"
AWS_ACCOUNT_ID="269416271598"
IMAGE_NAME="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    print_error "AWS CLI is not installed. Please install it first."
    exit 1
fi

# Check if Docker is installed and running
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install it first."
    exit 1
fi

if ! docker info &> /dev/null; then
    print_error "Docker is not running. Please start Docker first."
    exit 1
fi

# Get the current git commit SHA for tagging
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
IMAGE_TAG="${TIMESTAMP}-${GIT_SHA}"

print_info "Starting deployment process..."
print_info "Image will be tagged as: ${IMAGE_NAME}:${IMAGE_TAG}"
print_info "Image will also be tagged as: ${IMAGE_NAME}:latest"

# Step 1: Login to ECR
print_info "Logging in to Amazon ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

# Step 2: Build the Docker image
print_info "Building Docker image..."
docker build -t ${IMAGE_NAME}:${IMAGE_TAG} -t ${IMAGE_NAME}:latest .

# Step 3: Push to ECR
print_info "Pushing image to ECR..."
docker push ${IMAGE_NAME}:${IMAGE_TAG}
docker push ${IMAGE_NAME}:latest

print_info "Image successfully pushed to ECR!"
print_info "Image URI: ${IMAGE_NAME}:${IMAGE_TAG}"
print_info "Latest URI: ${IMAGE_NAME}:latest"

# Step 4: Deploy to cluster (if requested)
if [ "$1" == "--deploy" ] || [ "$1" == "-d" ]; then
    print_info "Deploying to cluster..."
    
    # Check if kubectl is available (for EKS)
    if command -v kubectl &> /dev/null; then
        print_info "kubectl found. Attempting EKS deployment..."
        
        # Try to update deployment
        if kubectl get deployment vayada-backend &> /dev/null; then
            print_info "Updating Kubernetes deployment..."
            kubectl set image deployment/vayada-backend \
                backend=${IMAGE_NAME}:${IMAGE_TAG} \
                --record
            
            print_info "Waiting for rollout to complete..."
            kubectl rollout status deployment/vayada-backend
            
            print_info "Deployment successful!"
        else
            print_warning "Kubernetes deployment 'vayada-backend' not found."
            print_info "You may need to create the deployment manually or use a different method."
        fi
    # Check if ECS CLI is available
    elif command -v ecs-cli &> /dev/null; then
        print_info "ECS CLI found. Attempting ECS deployment..."
        print_warning "ECS deployment requires additional configuration."
        print_info "Please update your ECS service manually or use AWS Console/CLI."
    else
        print_warning "Neither kubectl nor ecs-cli found."
        print_info "Please deploy manually using:"
        print_info "  - AWS Console"
        print_info "  - AWS CLI: aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment"
        print_info "  - kubectl: kubectl set image deployment/<deployment> backend=${IMAGE_NAME}:${IMAGE_TAG}"
    fi
else
    print_info "Skipping cluster deployment. Use --deploy flag to deploy automatically."
    print_info "To deploy manually:"
    print_info "  - ECS: aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment"
    print_info "  - EKS: kubectl set image deployment/<deployment> backend=${IMAGE_NAME}:${IMAGE_TAG}"
fi

print_info "Deployment script completed successfully!"

