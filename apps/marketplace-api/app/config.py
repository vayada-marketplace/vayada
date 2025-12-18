"""
Application configuration using environment variables
"""
from pydantic import Field
from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    """Application settings loaded from environment variables"""
    
    # API Configuration
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8000
    API_TITLE: str = "Vayada API"
    API_VERSION: str = "1.0.0"
    
    # Database Configuration
    # Require explicit database URL in env (no baked-in default)
    DATABASE_URL: str = Field(..., description="PostgreSQL connection string")
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60
    
    # CORS Configuration
    # Require explicit frontend origins in env (no baked-in default)
    CORS_ORIGINS: str = Field(..., description="Comma-separated allowed origins")
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: str = "*"  # Comma-separated or "*" for all
    CORS_ALLOW_HEADERS: str = "*"   # Comma-separated or "*" for all
    
    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    
    # JWT Configuration
    JWT_SECRET_KEY: str = "your-secret-key-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    
    # Email Configuration
    EMAIL_ENABLED: bool = True
    EMAIL_FROM_ADDRESS: str = Field("noreply@vayada.com", description="Email address to send from")
    EMAIL_FROM_NAME: str = "Vayada"
    FRONTEND_URL: str = Field("https://vayada.com", description="Frontend URL for reset password links")
    
    # SMTP Configuration (for sending emails via SMTP)
    SMTP_HOST: str = Field("", description="SMTP server host (e.g., smtp.gmail.com)")
    SMTP_PORT: int = 587
    SMTP_USER: str = Field("", description="SMTP username/email")
    SMTP_PASSWORD: str = Field("", description="SMTP password")
    SMTP_USE_TLS: bool = True
    
    # Alternative: Email Service API (e.g., SendGrid, AWS SES)
    # If using an email service, set EMAIL_SERVICE_API_KEY instead of SMTP settings
    EMAIL_SERVICE_API_KEY: str = Field("", description="API key for email service (SendGrid, etc.)")
    EMAIL_SERVICE_PROVIDER: str = Field("smtp", description="Email service provider: 'smtp', 'sendgrid', 'ses'")
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        origins = [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]
        # Always allow our canonical domains even if secrets/env omit them
        canonical_origins = ["https://vayada.com", "https://www.vayada.com"]
        # Preserve order while de-duplicating
        seen = set()
        merged = []
        for origin in origins + canonical_origins:
            if origin and origin not in seen:
                seen.add(origin)
                merged.append(origin)
        return merged
    
    @property
    def cors_methods_list(self) -> List[str]:
        """Parse CORS methods - returns ["*"] if set to "*", otherwise comma-separated list"""
        if self.CORS_ALLOW_METHODS.strip() == "*":
            return ["*"]
        return [method.strip() for method in self.CORS_ALLOW_METHODS.split(",") if method.strip()]
    
    @property
    def cors_headers_list(self) -> List[str]:
        """Parse CORS headers - returns ["*"] if set to "*", otherwise comma-separated list"""
        if self.CORS_ALLOW_HEADERS.strip() == "*":
            return ["*"]
        return [header.strip() for header in self.CORS_ALLOW_HEADERS.split(",") if header.strip()]


# Create global settings instance
settings = Settings()

