"""
Application configuration using environment variables
"""
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
    DATABASE_URL: str = "postgresql://vayada_user:vayada_password@postgres:5432/vayada_db"
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60
    
    # CORS Configuration
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"
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
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = True
    
    @property
    def cors_origins_list(self) -> List[str]:
        """Parse CORS origins from comma-separated string"""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]
    
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

