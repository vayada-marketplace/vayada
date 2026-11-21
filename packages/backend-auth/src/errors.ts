export type AuthErrorCode =
  | "TOKEN_MISSING"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "USER_NOT_FOUND"
  | "USER_SUSPENDED"
  | "ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_SUSPENDED"
  | "MEMBERSHIP_NOT_FOUND";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * Thrown by requireAuthContext when the request has no resolved context.
 * Fastify's default error handler maps statusCode to the HTTP response status,
 * so throwing this produces a 401 response without needing access to FastifyReply.
 */
export class UnauthorizedError extends Error {
  readonly statusCode = 401;

  constructor(message = "A valid access token is required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class AuthorizationResolutionError extends Error {
  readonly statusCode = 403;
  readonly code = "invalid_permission_override";

  constructor() {
    super("The authenticated user is not authorized for this resource.");
    this.name = "AuthorizationResolutionError";
  }
}

/**
 * An AI action that acts as a user (VAY-2506) was refused: a wrong or second use of its one-shot
 * scope, a route its action did not declare, or a context that is not a narrowed delegation.
 */
export class DelegationRefusedError extends Error {
  readonly statusCode = 403;
  readonly code = "delegation_refused";

  constructor(readonly reason: string) {
    super(`Delegated request refused: ${reason}.`);
    this.name = "DelegationRefusedError";
  }
}
