export type ExternalChangePresentation = {
  provider: string;
  state: string;
  allowedActions: string[];
  /** Server capability only; does not verify amounts or grant decision permission. */
  supportsUnverifiedMoney?: boolean;
  refreshAction: string | null;
  oldTotal: number | null;
  newTotal: number | null;
  priceDifference: number | null;
  currency: string | null;
  oldAdults: number | null;
  oldChildren: number | null;
  requestedAdults: number | null;
  requestedChildren: number | null;
};

/** Read-only boundary: provider metadata remains opaque to Booking. */
export interface ExternalChangePresentationPort {
  isManaged(changes: unknown): boolean;
  project(
    changes: Record<string, unknown>,
    enabled: boolean,
    status: string,
    allowUnverifiedMoney?: boolean,
  ): ExternalChangePresentation | undefined;
}
