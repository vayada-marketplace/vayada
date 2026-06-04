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
