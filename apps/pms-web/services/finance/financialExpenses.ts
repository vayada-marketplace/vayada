import type {
  FinanceExpense,
  FinanceExpenseCategory,
  FinanceExpenseEnvelope,
  FinanceExpenseExportQuery,
  FinanceExpenseOrigin,
  FinanceExpensePaymentStatus,
  FinanceExpenseSort,
  FinanceExpenseWrite,
  FinanceRecurringExpenseRule,
  FinanceReportingCountMetric,
  FinanceReportingMoney,
  FinanceReportingMoneyMetric,
} from "@vayada/domain-finance";

import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";

export type ExpenseFilters = {
  from: string;
  to: string;
  categoryId?: string;
  paymentStatus?: FinanceExpensePaymentStatus;
  recurring?: boolean;
  origin?: FinanceExpenseOrigin;
  search?: string;
  sort: FinanceExpenseSort;
};

export type FinanceExpensesResponse = FinanceExpenseEnvelope & {
  summary: {
    totalMtd: FinanceReportingMoneyMetric;
    perOccupiedNight: FinanceReportingMoneyMetric;
    unpaidAmount: FinanceReportingMoneyMetric;
    unpaidCount: FinanceReportingCountMetric;
  };
  categories: Array<{ category: FinanceExpenseCategory; amount: FinanceReportingMoney }>;
  page: { items: FinanceExpense[]; nextCursor: string | null; limit: number };
};

export type ExpenseCategoriesResponse = FinanceExpenseEnvelope & {
  item: FinanceExpenseCategory[];
};

export type ExpenseWriteResponse<T> = FinanceExpenseEnvelope & {
  item: T;
  outcome: "created" | "updated" | "replayed";
};

type ExportItem = {
  resourceId: string;
  state: "pending" | "running" | "failed" | "expired" | "ready";
};

type ExportEnqueueResponse = FinanceExpenseEnvelope & {
  item: ExportItem;
  outcome: "created" | "replayed";
};

type ExportStatusResponse = {
  contractVersion: "pms-financials-export.v1";
  propertyId: string;
  item: {
    resourceId: string;
    state: "pending" | "running" | "failed" | "expired" | "ready";
    expiresAt: string;
    download?: { method: "GET"; url: string; expiresAt: string };
    artifact?: { filename: string; contentType: string; sizeBytes: number };
  };
};

const root = (propertyId: string) =>
  `/api/finance/properties/${encodeURIComponent(propertyId)}/financials`;

export function getFinanceExpenses(
  propertyId: string,
  filters: ExpenseFilters,
  input: { cursor?: string; signal?: AbortSignal } = {},
): Promise<FinanceExpensesResponse> {
  const query = expenseQuery(filters);
  query.set("limit", "50");
  if (input.cursor) query.set("cursor", input.cursor);
  return pmsOperationsClient.get<FinanceExpensesResponse>(`${root(propertyId)}/expenses?${query}`, {
    ...pmsOperationsRequestOptions,
    signal: input.signal,
  });
}

export function getExpenseCategories(
  propertyId: string,
  signal?: AbortSignal,
): Promise<ExpenseCategoriesResponse> {
  return pmsOperationsClient.get<ExpenseCategoriesResponse>(
    `${root(propertyId)}/expense-categories`,
    { ...pmsOperationsRequestOptions, signal },
  );
}

export function createExpense(
  propertyId: string,
  fields: Omit<FinanceExpenseWrite, "commandId" | "idempotencyKey">,
  id = crypto.randomUUID(),
): Promise<ExpenseWriteResponse<FinanceExpense | FinanceRecurringExpenseRule>> {
  return pmsOperationsClient.post<
    ExpenseWriteResponse<FinanceExpense | FinanceRecurringExpenseRule>
  >(
    `${root(propertyId)}/expenses`,
    { ...fields, commandId: id, idempotencyKey: id },
    { ...pmsOperationsRequestOptions, headers: { "Idempotency-Key": id } },
  );
}

export function createExpenseCategory(
  propertyId: string,
  fields: Pick<FinanceExpenseCategory, "name" | "color" | "sortOrder">,
  id = crypto.randomUUID(),
): Promise<ExpenseWriteResponse<FinanceExpenseCategory>> {
  return pmsOperationsClient.post<ExpenseWriteResponse<FinanceExpenseCategory>>(
    `${root(propertyId)}/expense-categories`,
    { ...fields, commandId: id, idempotencyKey: id },
    { ...pmsOperationsRequestOptions, headers: { "Idempotency-Key": id } },
  );
}

export function updateExpenseCategory(
  propertyId: string,
  category: FinanceExpenseCategory,
  fields: Partial<Pick<FinanceExpenseCategory, "name" | "color" | "sortOrder">>,
  id = crypto.randomUUID(),
): Promise<ExpenseWriteResponse<FinanceExpenseCategory>> {
  return pmsOperationsClient.patch<ExpenseWriteResponse<FinanceExpenseCategory>>(
    `${root(propertyId)}/expense-categories/${encodeURIComponent(category.id)}`,
    { ...fields, expectedRevision: category.revision, commandId: id, idempotencyKey: id },
    { ...pmsOperationsRequestOptions, headers: { "Idempotency-Key": id } },
  );
}

export function archiveExpenseCategory(
  propertyId: string,
  category: FinanceExpenseCategory,
  id = crypto.randomUUID(),
): Promise<ExpenseWriteResponse<FinanceExpenseCategory>> {
  return pmsOperationsClient.delete<ExpenseWriteResponse<FinanceExpenseCategory>>(
    `${root(propertyId)}/expense-categories/${encodeURIComponent(category.id)}`,
    {
      ...pmsOperationsRequestOptions,
      headers: { "Idempotency-Key": id },
      body: JSON.stringify({
        expectedRevision: category.revision,
        commandId: id,
        idempotencyKey: id,
      }),
    },
  );
}

export function requestExpenseCsv(
  propertyId: string,
  filters: ExpenseFilters,
): Promise<ExportEnqueueResponse> {
  const id = crypto.randomUUID();
  const exportFilters: FinanceExpenseExportQuery = {
    from: filters.from,
    to: filters.to,
    sort: filters.sort,
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.recurring === undefined ? {} : { recurring: filters.recurring }),
    ...(filters.origin ? { origin: filters.origin } : {}),
    ...(filters.search ? { search: filters.search } : {}),
  };
  return pmsOperationsClient.post<ExportEnqueueResponse>(
    `${root(propertyId)}/exports`,
    { commandId: id, idempotencyKey: id, tab: "expenses", format: "csv", filters: exportFilters },
    {
      ...pmsOperationsRequestOptions,
      headers: { "Idempotency-Key": id },
    },
  );
}

export function getExpenseCsv(propertyId: string, exportId: string): Promise<ExportStatusResponse> {
  return pmsOperationsClient.get<ExportStatusResponse>(
    `${root(propertyId)}/exports/${encodeURIComponent(exportId)}`,
    pmsOperationsRequestOptions,
  );
}

function expenseQuery(filters: ExpenseFilters): URLSearchParams {
  const query = new URLSearchParams({ from: filters.from, to: filters.to, sort: filters.sort });
  if (filters.categoryId) query.set("categoryId", filters.categoryId);
  if (filters.paymentStatus) query.set("paymentStatus", filters.paymentStatus);
  if (filters.recurring !== undefined) query.set("recurring", String(filters.recurring));
  if (filters.origin) query.set("origin", filters.origin);
  if (filters.search) query.set("search", filters.search);
  return query;
}
