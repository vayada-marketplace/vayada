from pydantic import Field, ConfigDict
from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # API Configuration
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8001
    API_TITLE: str = "Vayada Booking Engine API"
    API_VERSION: str = "1.0.0"

    # Database Configuration
    DATABASE_URL: str = Field(..., description="PostgreSQL connection string")
    AUTH_DATABASE_URL: str = Field(..., description="Auth PostgreSQL connection string")
    MARKETPLACE_DATABASE_URL: str = Field(default="", description="Marketplace PostgreSQL connection string (optional, for pre-fill)")
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60

    # JWT Configuration (must match marketplace)
    JWT_SECRET_KEY: str = Field(..., description="JWT secret key (must match marketplace)")
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24

    # CORS Configuration
    CORS_ORIGINS: str = Field(..., description="Comma-separated allowed origins")
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: str = "*"
    CORS_ALLOW_HEADERS: str = "*"

    # Frontend URL (for reset password links)
    FRONTEND_URL: str = Field("http://localhost:3003", description="Frontend URL for reset password links")

    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    @property
    def cors_origins_list(self) -> List[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        seen = set()
        unique = []
        for o in origins:
            if o not in seen:
                seen.add(o)
                unique.append(o)
        return unique

    @property
    def cors_methods_list(self) -> List[str]:
        if self.CORS_ALLOW_METHODS.strip() == "*":
            return ["*"]
        return [m.strip() for m in self.CORS_ALLOW_METHODS.split(",") if m.strip()]

    @property
    def cors_headers_list(self) -> List[str]:
        if self.CORS_ALLOW_HEADERS.strip() == "*":
            return ["*"]
        return [h.strip() for h in self.CORS_ALLOW_HEADERS.split(",") if h.strip()]


settings = Settings()
