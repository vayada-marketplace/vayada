import { getAuthCsrfToken } from "./sessionStore";

export type AdminTransferRequest = {
  targetMembershipId: string;
  expectedActorRevision: string;
  expectedTargetRevision: string;
  formerAdmin: {
    roleDefinitionId: string;
    expectedRoleRevision: string;
    propertyAccessMode: "all";
    propertyIds: [];
    permissionOverrides: { grant: []; deny: [] };
    productAccess: { pms: true; booking: true };
  };
};

const PENDING_TRANSFER_KEY = "vayada.pending-admin-transfer.v1";

export class AdminTransferHttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

export function isTerminalAdminTransferError(error: unknown): boolean {
  return error instanceof AdminTransferHttpError && error.status >= 400 && error.status < 500;
}

async function post<T>(path: string, transfer: AdminTransferRequest): Promise<T> {
  const csrf = getAuthCsrfToken();
  if (!csrf) throw new Error("session_expired");
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vayada-csrf": csrf },
    body: JSON.stringify({ transfer }),
  });
  const body = (await response.json()) as T | { error?: string } | null;
  if (!response.ok) {
    const code =
      typeof body === "object" && body !== null && "error" in body && body.error
        ? body.error
        : "transfer_failed";
    throw new AdminTransferHttpError(response.status, code);
  }
  return body as T;
}

export async function startAdminTransfer(transfer: AdminTransferRequest): Promise<void> {
  const result = await post<{ authorizationUrl: string }>("/auth/admin-transfer/start", transfer);
  sessionStorage.setItem(PENDING_TRANSFER_KEY, JSON.stringify(transfer));
  window.location.assign(result.authorizationUrl);
}

export async function completePendingAdminTransfer(): Promise<
  "transferred" | "idempotent_replay" | "missing"
> {
  const raw = sessionStorage.getItem(PENDING_TRANSFER_KEY);
  if (!raw) return "missing";
  let transfer: AdminTransferRequest;
  try {
    transfer = JSON.parse(raw) as AdminTransferRequest;
  } catch {
    sessionStorage.removeItem(PENDING_TRANSFER_KEY);
    return "missing";
  }
  const result = await post<{ outcome: "transferred" | "idempotent_replay" }>(
    "/auth/admin-transfer/complete",
    transfer,
  );
  if (!result || !["transferred", "idempotent_replay"].includes(result.outcome))
    throw new Error("transfer_response_invalid");
  sessionStorage.removeItem(PENDING_TRANSFER_KEY);
  return result.outcome;
}

export function clearPendingAdminTransfer(): void {
  sessionStorage.removeItem(PENDING_TRANSFER_KEY);
}
