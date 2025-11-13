# AWS Deployment Strategy

## Current Setup Analysis

### ✅ What's Good for AWS

1. **Containerized Application**
   - Docker containerization works well with AWS ECS, EKS, or Elastic Beanstalk
   - FastAPI is production-ready and performant
   - Health check endpoints (`/health`, `/health/db`) are perfect for ALB/ECS health checks

2. **Database Connection Pooling**
   - Using `asyncpg` with connection pooling is efficient
   - Pool configuration (min_size=2, max_size=10) is reasonable for starting

3. **Separation of Concerns**
   - Database separate from application (will use RDS in production)
   - Environment-based configuration ready

4. **Async Architecture**
   - FastAPI + asyncpg is scalable and efficient

### ⚠️ What Needs Improvement for AWS

1. **Database**
   - ❌ Currently: Docker PostgreSQL (local dev only)
   - ✅ Should use: **AWS RDS PostgreSQL** (managed, scalable, automated backups)

2. **Migrations**
   - ❌ Currently: Raw SQL files executed on container startup
   - ✅ Should use: **Alembic** (versioned migrations, rollback support, better for production)

3. **Environment Configuration**
   - ❌ Currently: Hardcoded values in docker-compose.yml
   - ✅ Should use: **AWS Secrets Manager** or **Parameter Store** for sensitive data

4. **CORS Configuration**
   - ⚠️ Currently: Hardcoded origins
   - ✅ Should: Read from environment variables

5. **Connection String Parsing**
   - ⚠️ Currently: Direct DATABASE_URL usage
   - ✅ Should: Parse RDS connection string properly (SSL, timeouts, etc.)

6. **Logging**
   - ⚠️ Currently: Basic logging
   - ✅ Should: Integrate with **CloudWatch Logs**

7. **Secrets Management**
   - ❌ Currently: Passwords in docker-compose.yml
   - ✅ Should: Use AWS Secrets Manager

## Recommended AWS Architecture

### Option 1: ECS Fargate (Recommended for Start)
```
┌─────────────────┐
│  CloudFront     │ (Optional CDN)
└────────┬────────┘
         │
┌────────▼────────┐
│  Application    │
│  Load Balancer  │ (ALB)
└────────┬────────┘
         │
┌────────▼────────┐      ┌──────────────┐
│  ECS Fargate    │◄─────┤  RDS         │
│  (Backend)      │      │  PostgreSQL  │
└─────────────────┘      └──────────────┘
         │
┌────────▼────────┐
│  S3 + CloudFront│ (Frontend)
└─────────────────┘
```

**Pros:**
- Serverless containers (no EC2 management)
- Auto-scaling built-in
- Cost-effective for variable traffic
- Easy to set up

**Cons:**
- Cold starts possible
- Less control than EC2

### Option 2: EKS (For Larger Scale)
- More complex setup
- Better for microservices
- More control and flexibility

### Option 3: Elastic Beanstalk (Simplest)
- Easiest deployment
- Less flexible
- Good for getting started quickly

## Migration Path

### Phase 1: Prepare for AWS (Current)
- [x] Containerize application
- [x] Health check endpoints
- [ ] Add Alembic for migrations
- [ ] Environment-based configuration
- [ ] CloudWatch logging
- [ ] CORS from environment

### Phase 2: AWS Setup
- [ ] Create RDS PostgreSQL instance
- [ ] Set up ECS cluster or Elastic Beanstalk
- [ ] Configure Secrets Manager
- [ ] Set up Application Load Balancer
- [ ] Configure CloudWatch Logs

### Phase 3: Deployment
- [ ] CI/CD pipeline (GitHub Actions / CodePipeline)
- [ ] Database migrations in deployment
- [ ] Blue-green or rolling deployments
- [ ] Monitoring and alerts

## Immediate Improvements Needed

1. **Add Alembic for migrations** (instead of raw SQL)
2. **Environment-based CORS** (read from env vars)
3. **CloudWatch logging integration**
4. **RDS connection string handling** (SSL, proper parsing)
5. **Secrets management** (AWS Secrets Manager integration)

## Cost Estimate (Monthly)

- **RDS PostgreSQL (db.t3.micro)**: ~$15-20/month
- **ECS Fargate (0.5 vCPU, 1GB RAM)**: ~$10-15/month
- **Application Load Balancer**: ~$16/month
- **CloudWatch Logs**: ~$1-5/month
- **Data Transfer**: ~$1-10/month
- **Total**: ~$50-70/month for small scale

## Next Steps

1. Keep current setup for local development ✅
2. Add production-ready features (Alembic, env config, logging)
3. Create separate docker-compose for production-like testing
4. Set up AWS infrastructure
5. Deploy and test

