import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export type Money = { amount: string; currency: string };
export type FolioSummary = {
  folioId: string;
  bookingId: string | null;
  revision: number;
  state: "draft" | "ready" | "archived" | "superseded";
  serviceFrom: string;
  serviceTo: string;
  total: Money;
  createdAt: string;
};
export type Folio = FolioSummary & {
  recipient: { name: string; email: string | null };
  lines: Array<{
    lineId: string;
    kind: string;
    description: string;
    quantity: string;
    total: Money;
    serviceOn: string;
  }>;
  paymentRefs: Array<{ paymentId: string; amount: Money }>;
};
type ListResponse = {
  currency: string;
  page: { items: FolioSummary[]; nextCursor: string | null };
};
type DetailResponse = { item: Folio };
type CommandResponse = { resourceId: string; revision: number };
type ExportResponse = { item: { resourceId: string; state: string; download?: { url: string } } };

const root = (propertyId: string) =>
  `/api/finance/properties/${encodeURIComponent(propertyId)}/financials`;
const commandOptions = (idempotencyKey: string): RequestInit => ({
  ...pmsOperationsRequestOptions,
  headers: { "Idempotency-Key": idempotencyKey },
});
const commandId = () => crypto.randomUUID();

export function listFolios(propertyId: string, filters: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return pmsOperationsClient.get<ListResponse>(
    `${root(propertyId)}/folios?${query}`,
    pmsOperationsRequestOptions,
  );
}

export function getFolio(propertyId: string, folioId: string) {
  return pmsOperationsClient.get<DetailResponse>(
    `${root(propertyId)}/folios/${encodeURIComponent(folioId)}`,
    pmsOperationsRequestOptions,
  );
}

export function prepareFolio(
  propertyId: string,
  input: {
    recipientName: string;
    recipientEmail: string;
    from: string;
    to: string;
    description: string;
    amount: string;
    currency: string;
  },
  id = commandId(),
) {
  return pmsOperationsClient.post<CommandResponse>(
    `${root(propertyId)}/folios`,
    {
      commandId: id,
      idempotencyKey: id,
      recipient: { name: input.recipientName, email: input.recipientEmail || null },
      serviceFrom: input.from,
      serviceTo: input.to,
      lines: [
        {
          position: 1,
          kind: "adjustment",
          description: input.description,
          quantity: "1",
          unitAmount: { amount: input.amount, currency: input.currency },
          serviceOn: input.from,
          source: { type: "manual", id, revision: 1 },
        },
      ],
      paymentRefs: [],
    },
    commandOptions(id),
  );
}

export function finalizeFolio(
  propertyId: string,
  folioId: string,
  revision: number,
  id = commandId(),
) {
  return pmsOperationsClient.post<CommandResponse>(
    `${root(propertyId)}/folios/${encodeURIComponent(folioId)}/ready`,
    { commandId: id, idempotencyKey: id, expectedRevision: revision },
    commandOptions(id),
  );
}

export function requestFolioCsv(propertyId: string, filters: Record<string, string | undefined>) {
  const id = commandId();
  return pmsOperationsClient.post<ExportResponse>(
    `${root(propertyId)}/exports`,
    {
      commandId: id,
      idempotencyKey: id,
      tab: "folios",
      format: "csv",
      filters: { ...filters, state: "ready" },
    },
    commandOptions(id),
  );
}

export function getFolioCsv(propertyId: string, exportId: string) {
  return pmsOperationsClient.get<ExportResponse>(
    `${root(propertyId)}/exports/${encodeURIComponent(exportId)}`,
    pmsOperationsRequestOptions,
  );
}
