from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # API Configuration
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8001
    API_TITLE: str = "vayada Booking Engine API"
    API_VERSION: str = "1.0.0"

    # Database Configuration
    DATABASE_URL: str = Field(..., description="PostgreSQL connection string")
    AUTH_DATABASE_URL: str = Field(..., description="Auth PostgreSQL connection string")
    MARKETPLACE_DATABASE_URL: str = Field(
        default="", description="Marketplace PostgreSQL connection string (optional, for pre-fill)"
    )
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60

    # JWT Configuration (must match marketplace)
    JWT_SECRET_KEY: str = Field(..., description="JWT secret key (must match marketplace)")
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24

    # 2FA Configuration
    TOTP_ENCRYPTION_KEY: str = Field(
        "0" * 64,
        description="64-char hex key (32 bytes) for AES-encrypting TOTP secrets in the DB. "
        "Generate: openssl rand -hex 32. Must match marketplace-api and be in ECS task defs.",
    )

    # CORS Configuration
    CORS_ORIGINS: str = Field(..., description="Comma-separated allowed origins")
    # Default permits portless local-dev origins (https://*.localhost). Prod
    # overrides via env to the explicit production origin regex.
    CORS_ORIGIN_REGEX: str = Field(
        default=r"^https://([^.]+\.)*localhost(:\d+)?$",
        description="Regex for wildcard origin matching (e.g. https://.*\\.booking\\.vayada\\.com)",
    )
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: str = "*"
    CORS_ALLOW_HEADERS: str = "*"

    # PMS Configuration
    PMS_API_URL: str = Field(
        "https://pms-api.vayada.com", description="PMS backend URL for hotel lifecycle sync"
    )
    PMS_DATABASE_URL: str = Field(
        default="", description="PMS PostgreSQL connection string (for dashboard stats)"
    )

    # Frontend URL (for reset password links)
    FRONTEND_URL: str = Field(
        "http://localhost:3003", description="Frontend URL for reset password links"
    )

    # Shared secret for server-to-server endpoints (currently:
    # /api/hotels/{slug}/increment-promo, called by pms-backend on
    # successful booking). When empty, the endpoints stay open for
    # backward compat — set this on both backends to enable enforcement.
    INTERNAL_API_KEY: str = Field(
        default="", description="Shared secret for server-to-server endpoints; opt-in"
    )

    # Cloudflare for SaaS (custom domains)
    CLOUDFLARE_API_TOKEN: str = Field(
        default="", description="Cloudflare API token for custom hostname management"
    )
    CLOUDFLARE_ZONE_ID: str = Field(default="", description="Cloudflare zone ID for vayada.com")

    # Email Configuration
    EMAIL_ENABLED: bool = False
    EMAIL_FROM_ADDRESS: str = "noreply@vayada.com"
    EMAIL_FROM_NAME: str = "vayada"
    EMAIL_SERVICE_PROVIDER: str = "smtp"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_USE_TLS: bool = True

    # Auth Cookie (shared with all *.vayada.com frontends)
    # Set AUTH_COOKIE_DOMAIN to ".vayada.com" in prod so subdomains
    # (affiliate.vayada.com, pms.vayada.com, etc.) all see the cookie.
    # Leave empty in dev so it defaults to the response host.
    AUTH_COOKIE_DOMAIN: str = Field(
        default="", description="Cookie domain — '.vayada.com' in prod, empty in dev"
    )
    # Prod (cross-subdomain): samesite=none + secure=true.
    # Dev (http://localhost): samesite=lax + secure=false — same-site
    # requests get the cookie regardless of method, no Secure needed.
    AUTH_COOKIE_SECURE: bool = Field(
        default=True, description="Secure flag on auth cookies; False for http://localhost dev"
    )
    AUTH_COOKIE_SAMESITE: str = Field(
        default="none", description="lax | none | strict — must be 'none' for cross-subdomain prod"
    )

    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        seen = set()
        unique = []
        for o in origins:
            if o not in seen:
                seen.add(o)
                unique.append(o)
        return unique

    @property
    def cors_methods_list(self) -> list[str]:
        if self.CORS_ALLOW_METHODS.strip() == "*":
            return ["*"]
        return [m.strip() for m in self.CORS_ALLOW_METHODS.split(",") if m.strip()]

    @property
    def cors_headers_list(self) -> list[str]:
        if self.CORS_ALLOW_HEADERS.strip() == "*":
            return ["*"]
        return [h.strip() for h in self.CORS_ALLOW_HEADERS.split(",") if h.strip()]


settings = Settings()
