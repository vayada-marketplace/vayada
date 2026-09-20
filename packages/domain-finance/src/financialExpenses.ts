export const PMS_FINANCIALS_CONTRACT_VERSION = "pms-financials.v1" as const;

// prettier-ignore
export const FINANCE_EXPENSE_ORIGINS = ["manual", "recurring", "ota_commission", "platform_fee", "supplier_bill"] as const;
export const FINANCE_EXPENSE_CADENCES = ["weekly", "monthly", "yearly"] as const;
export const FINANCE_EXPENSE_PAYMENT_STATUSES = ["paid", "unpaid"] as const;
export const FINANCE_EXPENSE_SORTS = ["incurredOn_desc", "amount_desc"] as const;

export type FinanceExpenseOrigin = (typeof FINANCE_EXPENSE_ORIGINS)[number];
export type FinanceExpenseCadence = (typeof FINANCE_EXPENSE_CADENCES)[number];
export type FinanceExpensePaymentStatus = (typeof FINANCE_EXPENSE_PAYMENT_STATUSES)[number];
export type FinanceExpenseSort = (typeof FINANCE_EXPENSE_SORTS)[number];
declare const financeExpenseAmountBrand: unique symbol;
export type FinanceExpenseAmount = string & { readonly [financeExpenseAmountBrand]: true };
// prettier-ignore
export type FinanceExpensePayment = { paymentStatus: "paid"; paidOn: string } | { paymentStatus: "unpaid"; paidOn: null };
// prettier-ignore
export type FinanceExpensePaymentWrite = { paymentStatus: "paid"; paidOn: string } | { paymentStatus: "unpaid"; paidOn?: null };

export type FinanceExpenseMoney = { amount: FinanceExpenseAmount; currency: string };
export type FinanceExpensePage<T> = { items: T[]; nextCursor: string | null; limit: number };
export type FinanceExpenseIncompleteEvidence = {
  code: string;
  count: number;
  amount?: { amount: string; currency: string };
};
export type FinanceExpenseEnvelope = {
  contractVersion: typeof PMS_FINANCIALS_CONTRACT_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness: Record<string, string>;
  incompleteEvidence: readonly FinanceExpenseIncompleteEvidence[];
};
export type FinanceExpenseCommand = {
  commandId: string;
  idempotencyKey: string;
  expectedRevision?: number;
};
export type FinanceExpenseCategory = {
  id: string;
  systemKey: string | null;
  name: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  revision: number;
};
// prettier-ignore
export type FinanceExpense = { id: string; categoryId: string; origin: FinanceExpenseOrigin;
  incurredOn: string; vendor: string; amount: FinanceExpenseMoney; recurringRuleId: string | null;
  sourceKey: string | null; reversesExpenseId: string | null; revision: number;
  supplierInvoiceNumber?: string | null } & FinanceExpensePayment;
// prettier-ignore
export type FinanceRecurringExpenseRule = { id: string; categoryId: string; vendor: string;
  amount: FinanceExpenseMoney; notes?: string; paymentStatus: FinanceExpensePaymentStatus;
  cadence: FinanceExpenseCadence; startsOn: string; nextDueOn: string; endsOn: string | null;
  active: boolean; revision: number };
export type FinanceExpenseQuery = {
  from: string;
  to: string;
  cursor?: string;
  limit: number;
  categoryId?: string;
  paymentStatus?: FinanceExpensePaymentStatus;
  recurring?: boolean;
  origin?: FinanceExpenseOrigin;
  search?: string;
  sort: FinanceExpenseSort;
};
export type FinanceExpenseExportQuery = Omit<FinanceExpenseQuery, "cursor" | "limit">;
export const FINANCE_EXPENSE_CSV_VERSION = "pms-financials-expenses.v1" as const;
export const FINANCE_EXPENSE_CSV_CONTENT_TYPE = "text/csv; charset=utf-8" as const;
export const FINANCE_EXPENSE_CSV_COLUMNS = [
  "property_id",
  "expense_id",
  "incurred_on",
  "category_id",
  "category_name",
  "origin",
  "vendor",
  "amount",
  "currency",
  "payment_status",
  "paid_on",
  "recurring_rule_id",
  "source_key",
  "reverses_expense_id",
  "revision",
] as const;
export type FinanceExpenseCsvItem = FinanceExpense & { categoryName: string };
export type FinanceExpenseCsvArtifact = {
  formatVersion: typeof FINANCE_EXPENSE_CSV_VERSION;
  contentType: typeof FINANCE_EXPENSE_CSV_CONTENT_TYPE;
  propertyId: string;
  currency: string;
  filename: string;
  rowCount: number;
  body: string;
};
export type FinanceExpenseExportSelection = Readonly<{
  expenseId: string;
  revision: number;
  categoryId: string;
  categoryRevision: number;
  categoryName: string;
  paymentStatus: FinanceExpensePaymentStatus;
  paidOn: string | null;
}>;
export type FinanceExpenseExportSnapshot = Readonly<{
  formatVersion: typeof FINANCE_EXPENSE_CSV_VERSION;
  propertyId: string;
  currency: string;
  filters: FinanceExpenseExportQuery;
  snapshotAt: string;
  manifest: readonly FinanceExpenseExportSelection[];
}>;
export type FinanceExpenseRecurrenceWrite = {
  cadence: FinanceExpenseCadence;
  startsOn: string;
  endsOn?: string;
};
// prettier-ignore
export type FinanceExpenseWrite = FinanceExpenseCommand & { incurredOn: string; vendor: string;
  categoryId: string; amount: FinanceExpenseMoney; notes?: string; supplierInvoiceNumber?: string;
  receiptMediaId?: string; recurrence?: FinanceExpenseRecurrenceWrite } & FinanceExpensePaymentWrite;
export type FinanceExpenseCommandResult<T> =
  | { ok: true; outcome: "created" | "updated" | "replayed"; item: T }
  | {
      ok: false;
      code:
        | "invalid_command"
        | "not_found"
        | "revision_conflict"
        | "idempotency_conflict"
        | "currency_mismatch"
        | "evidence_mismatch"
        | "write_unavailable";
    };

export function normalizeFinanceExpenseAmount(value: string): FinanceExpenseAmount | null {
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const normalized = `${whole}.${fraction.padEnd(4, "0")}`;
  return normalized === "0.0000" ? null : (normalized as FinanceExpenseAmount);
}

export function parseFinanceExpenseQuery(value: unknown): FinanceExpenseQuery | null {
  if (!recordWithKnownKeys(value, QUERY_KEYS) || !localDate(value.from) || !localDate(value.to))
    return null;
  const sort =
    value.sort === undefined ? "incurredOn_desc" : oneOf(value.sort, FINANCE_EXPENSE_SORTS);
  const limit = queryLimit(value.limit);
  const recurring = queryBoolean(value.recurring);
  const query: FinanceExpenseQuery = {
    from: value.from,
    to: value.to,
    limit: limit ?? 0,
    sort: sort ?? "incurredOn_desc",
  };
  if (query.limit === 0 || !sort || query.from > query.to) return null;
  if (!optionalCursor(value.cursor)) return null;
  if (!optionalUuid(value.categoryId)) return null;
  if (!optionalOneOf(value.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES)) return null;
  if (recurring === null) return null;
  if (!optionalOneOf(value.origin, FINANCE_EXPENSE_ORIGINS)) return null;
  if (!optionalTrimmed(value.search, 1, 200)) return null;
  return compact({
    ...query,
    cursor: value.cursor as string | undefined,
    categoryId: value.categoryId as string | undefined,
    paymentStatus: value.paymentStatus as FinanceExpensePaymentStatus | undefined,
    recurring: recurring ?? undefined,
    origin: value.origin as FinanceExpenseOrigin | undefined,
    search: value.search as string | undefined,
  });
}

export function parseFinanceExpenseExportQuery(value: unknown): FinanceExpenseExportQuery | null {
  if (!recordWithKnownKeys(value, EXPORT_QUERY_KEYS)) return null;
  const parsed = parseFinanceExpenseQuery({ ...value, limit: 1 });
  if (!parsed) return null;
  const { cursor: _cursor, limit: _limit, ...query } = parsed;
  return compact({ ...query, categoryId: query.categoryId?.toLowerCase() });
}

export function parseFinanceExpenseExportSnapshot(
  value: unknown,
): FinanceExpenseExportSnapshot | null {
  if (
    !recordWithExactKeys(value, [
      "formatVersion",
      "propertyId",
      "currency",
      "filters",
      "snapshotAt",
      "manifest",
    ]) ||
    value.formatVersion !== FINANCE_EXPENSE_CSV_VERSION ||
    !canonicalUuid(value.propertyId) ||
    !/^[A-Z]{3}$/.test(String(value.currency)) ||
    !canonicalInstant(value.snapshotAt) ||
    !Array.isArray(value.manifest)
  )
    return null;
  const filters = parseFinanceExpenseExportQuery(value.filters),
    ids = new Set<string>(),
    manifest: FinanceExpenseExportSelection[] = [];
  if (!filters) return null;
  for (const raw of value.manifest) {
    if (
      !recordWithExactKeys(raw, [
        "expenseId",
        "revision",
        "categoryId",
        "categoryRevision",
        "categoryName",
        "paymentStatus",
        "paidOn",
      ])
    )
      return null;
    const paymentStatus = oneOf(raw.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES),
      paidOn = raw.paidOn;
    if (
      !canonicalUuid(raw.expenseId) ||
      !canonicalUuid(raw.categoryId) ||
      !revision(raw.revision) ||
      !revision(raw.categoryRevision) ||
      !trimmed(raw.categoryName, 1, 120) ||
      !paymentStatus ||
      !(
        (paymentStatus === "paid" && localDate(paidOn)) ||
        (paymentStatus === "unpaid" && paidOn === null)
      ) ||
      ids.has(raw.expenseId)
    )
      return null;
    ids.add(raw.expenseId);
    manifest.push({
      expenseId: raw.expenseId,
      revision: raw.revision,
      categoryId: raw.categoryId,
      categoryRevision: raw.categoryRevision,
      categoryName: raw.categoryName,
      paymentStatus,
      paidOn: paidOn as string | null,
    });
  }
  return {
    formatVersion: FINANCE_EXPENSE_CSV_VERSION,
    propertyId: value.propertyId,
    currency: String(value.currency),
    filters,
    snapshotAt: value.snapshotAt,
    manifest,
  };
}

export function buildFinanceExpenseCsvArtifact(input: {
  propertyId: string;
  currency: string;
  expenses: readonly FinanceExpenseCsvItem[];
}): FinanceExpenseCsvArtifact {
  if (
    !uuid(input.propertyId) ||
    input.propertyId !== input.propertyId.toLowerCase() ||
    !/^[A-Z]{3}$/.test(input.currency)
  )
    throw new TypeError("Expense CSV evidence violates the export contract");
  const ids = new Set<string>();
  for (const item of input.expenses) {
    if (!validCsvItem(item, input.currency) || ids.has(item.id))
      throw new TypeError("Expense CSV evidence violates the export contract");
    ids.add(item.id);
  }
  const rows = input.expenses.map((item) => [
    input.propertyId,
    item.id,
    item.incurredOn,
    item.categoryId,
    safeCsvText(item.categoryName),
    item.origin,
    safeCsvText(item.vendor),
    item.amount.amount,
    input.currency,
    item.paymentStatus,
    item.paidOn ?? "",
    item.recurringRuleId ?? "",
    safeCsvText(item.sourceKey ?? ""),
    item.reversesExpenseId ?? "",
    String(item.revision),
  ]);
  return {
    formatVersion: FINANCE_EXPENSE_CSV_VERSION,
    contentType: FINANCE_EXPENSE_CSV_CONTENT_TYPE,
    propertyId: input.propertyId,
    currency: input.currency,
    filename: `pms-financials-expenses-${input.propertyId}.csv`,
    rowCount: rows.length,
    body: [FINANCE_EXPENSE_CSV_COLUMNS, ...rows].map(csvRow).join("\r\n") + "\r\n",
  };
}

export function parseFinanceExpenseWrite(value: unknown): FinanceExpenseWrite | null {
  if (!recordWithKnownKeys(value, EXPENSE_WRITE_KEYS) || !hasKeys(value, EXPENSE_REQUIRED_KEYS))
    return null;
  const command = parseCommand(value);
  const amount = parseMoney(value.amount);
  const recurrence = parseRecurrence(value.recurrence);
  const paymentStatus = oneOf(value.paymentStatus, FINANCE_EXPENSE_PAYMENT_STATUSES);
  if (
    !command ||
    !localDate(value.incurredOn) ||
    !trimmed(value.vendor, 1, 200) ||
    !uuid(value.categoryId) ||
    !amount ||
    !paymentStatus ||
    (paymentStatus === "paid"
      ? !localDate(value.paidOn)
      : value.paidOn !== undefined && value.paidOn !== null) ||
    !optionalTrimmed(value.notes, 1, 2000) ||
    !optionalTrimmed(value.supplierInvoiceNumber, 1, 200) ||
    !optionalUuid(value.receiptMediaId) ||
    (recurrence !== undefined && value.receiptMediaId !== undefined) ||
    recurrence === null
  )
    return null;
  const payment =
    paymentStatus === "paid"
      ? { paymentStatus, paidOn: value.paidOn as string }
      : { paymentStatus, paidOn: value.paidOn as null | undefined };
  return compact({
    ...command,
    incurredOn: value.incurredOn,
    vendor: value.vendor,
    categoryId: value.categoryId,
    amount,
    ...payment,
    notes: value.notes as string | undefined,
    supplierInvoiceNumber: value.supplierInvoiceNumber as string | undefined,
    receiptMediaId: value.receiptMediaId as string | undefined,
    recurrence: recurrence ?? undefined,
  });
}

const COMMAND_KEYS = ["commandId", "idempotencyKey", "expectedRevision"] as const;
// prettier-ignore
const QUERY_KEYS = ["from", "to", "cursor", "limit", "categoryId", "paymentStatus", "recurring", "origin", "search", "sort"] as const;
const EXPORT_QUERY_KEYS = QUERY_KEYS.filter((key) => key !== "cursor" && key !== "limit");
// prettier-ignore
const EXPENSE_REQUIRED_KEYS = [...COMMAND_KEYS.slice(0, 2), "incurredOn", "vendor", "categoryId", "amount", "paymentStatus"];
const EXPENSE_WRITE_KEYS = [
  ...COMMAND_KEYS,
  ...EXPENSE_REQUIRED_KEYS.slice(2),
  "paidOn",
  "notes",
  "supplierInvoiceNumber",
  "receiptMediaId",
  "recurrence",
];

function parseCommand(value: Record<string, unknown>): FinanceExpenseCommand | null {
  return uuid(value.commandId) &&
    trimmed(value.idempotencyKey, 1, 200) &&
    (value.expectedRevision === undefined || revision(value.expectedRevision))
    ? compact({
        commandId: value.commandId,
        idempotencyKey: value.idempotencyKey,
        expectedRevision: value.expectedRevision,
      })
    : null;
}
function parseMoney(value: unknown): FinanceExpenseMoney | null {
  if (!recordWithExactKeys(value, ["amount", "currency"]) || typeof value.amount !== "string")
    return null;
  const amount = normalizeFinanceExpenseAmount(value.amount);
  return amount && typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)
    ? { amount, currency: value.currency }
    : null;
}
function parseRecurrence(value: unknown): FinanceExpenseRecurrenceWrite | null | undefined {
  if (value === undefined) return undefined;
  if (
    !recordWithKnownKeys(value, ["cadence", "startsOn", "endsOn"]) ||
    !hasKeys(value, ["cadence", "startsOn"])
  )
    return null;
  const cadence = oneOf(value.cadence, FINANCE_EXPENSE_CADENCES);
  if (
    !cadence ||
    !localDate(value.startsOn) ||
    !optionalLocalDate(value.endsOn) ||
    (value.endsOn !== undefined && (value.endsOn as string) < value.startsOn)
  )
    return null;
  return compact({ cadence, startsOn: value.startsOn, endsOn: value.endsOn as string | undefined });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordWithKnownKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => keys.includes(key));
}
function recordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return recordWithKnownKeys(value, keys) && hasKeys(value, keys);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && values.includes(value) ? (value as T[number]) : null;
}
function optionalOneOf<const T extends readonly string[]>(value: unknown, values: T): boolean {
  return value === undefined || oneOf(value, values) !== null;
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function optionalTrimmed(value: unknown, min: number, max: number): boolean {
  return value === undefined || trimmed(value, min, max);
}
function optionalCursor(value: unknown): boolean {
  // prettier-ignore
  return value === undefined || (typeof value === "string" && /^(?=.{2,4096}$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/.test(value));
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function canonicalUuid(value: unknown): value is string {
  return uuid(value) && value === value.toLowerCase();
}
function optionalUuid(value: unknown): boolean {
  return value === undefined || uuid(value);
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 200;
}
function queryLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  const parsed = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return validLimit(parsed) ? parsed : null;
}
function queryBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}
function optionalLocalDate(value: unknown): boolean {
  return value === undefined || localDate(value);
}
function localDate(value: unknown): value is string {
  if (typeof value !== "string" || value.startsWith("0000-") || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, part]) => part !== undefined)) as T;
}

function validCsvItem(value: FinanceExpenseCsvItem, currency: string): boolean {
  return (
    uuid(value.id) &&
    value.id === value.id.toLowerCase() &&
    uuid(value.categoryId) &&
    value.categoryId === value.categoryId.toLowerCase() &&
    FINANCE_EXPENSE_ORIGINS.includes(value.origin) &&
    localDate(value.incurredOn) &&
    trimmed(value.categoryName, 1, 120) &&
    trimmed(value.vendor, 1, 200) &&
    value.amount.currency === currency &&
    /^(?:0|[1-9]\d{0,14})\.\d{4}$/.test(value.amount.amount) &&
    BigInt(value.amount.amount.replace(".", "")) > 0n &&
    FINANCE_EXPENSE_PAYMENT_STATUSES.includes(value.paymentStatus) &&
    ((value.paymentStatus === "paid" && localDate(value.paidOn)) ||
      (value.paymentStatus === "unpaid" && value.paidOn === null)) &&
    [value.recurringRuleId, value.reversesExpenseId].every(
      (id) => id === null || (uuid(id) && id === id.toLowerCase()),
    ) &&
    (value.sourceKey === null || trimmed(value.sourceKey, 1, 250)) &&
    revision(value.revision)
  );
}
const safeCsvText = (value: string) => (/^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value);
const csvRow = (values: readonly string[]) =>
  values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",");
