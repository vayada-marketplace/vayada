from pydantic import Field, ConfigDict
from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    # API
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8002
    API_TITLE: str = "Vayada PMS API"
    API_VERSION: str = "1.0.0"

    # Database (PMS own DB)
    DATABASE_URL: str = Field(..., description="PMS PostgreSQL connection string")
    AUTH_DATABASE_URL: str = Field(..., description="Auth PostgreSQL connection string")
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60

    # JWT (must match booking engine)
    JWT_SECRET_KEY: str = Field(..., description="JWT secret key (must match booking engine)")
    JWT_ALGORITHM: str = "HS256"

    # CORS
    CORS_ORIGINS: str = Field(..., description="Comma-separated allowed origins")
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: str = "*"
    CORS_ALLOW_HEADERS: str = "*"

    # SMTP (optional)
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "noreply@vayada.com"
    SMTP_USE_TLS: bool = True

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


settings = Settings()
