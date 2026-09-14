export type ExternalChangePresentation = {
  provider: string;
  state: string;
  allowedActions: string[];
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
  project(changes: Record<string, unknown>, enabled: boolean, status: string): ExternalChangePresentation | undefined;
}
