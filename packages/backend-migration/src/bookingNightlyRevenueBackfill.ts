import { createHash } from "node:crypto";

export type NightlyRevenueSourceKind = "direct" | "ota" | "manual" | "migration";
export type NightlyRevenueQuality = "exact" | "inferred" | "missing";
export type NightlyRevenueBackfillCandidate = {
  propertyId: string;
  guestBookingId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  currency: string;
  lifecycleStatus: string;
  sourceKind: NightlyRevenueSourceKind;
  assignments: Array<{
    position: number;
    roomTypeId: string;
    stayEvidenceKind: "exact" | "summary_only";
    checkIn: string | null;
    checkOut: string | null;
  }>;
  retainedEvidence: {
    currency: string | null;
    exactNightly?: Array<{ position: number; stayDate: string; grossRoomAmount: string }>;
    grossRoomTotal?: string | null;
  };
};
export type NightlyRevenueBackfillLine = {
  propertyId: string;
  guestBookingId: string;
  roomTypeId: string;
  stayDate: string;
  currency: string;
  grossRoomAmount: string | null;
  linePosition: number;
  lifecycleState: "confirmed" | "completed";
  sourceKind: NightlyRevenueSourceKind;
  evidenceQuality: NightlyRevenueQuality;
  evidenceFingerprint: string;
};
export type NightlyRevenueBackfillException = {
  propertyId: string;
  guestBookingId: string;
  code:
    | "currency_mismatch"
    | "assignment_scope_mismatch"
    | "inference_not_approved"
    | "invalid_booking_scope"
    | "invalid_exact_evidence"
    | "invalid_retained_total"
    | "missing_evidence"
    | "non_recognizable_lifecycle"
    | "retained_total_mismatch";
  amounts?: { expected: string; planned: string; delta: string };
};
export function planNightlyRevenueBackfill(
  candidates: readonly NightlyRevenueBackfillCandidate[],
  options: { allowInferredEqualAllocation: boolean },
) {
  const lines: NightlyRevenueBackfillLine[] = [];
  const exceptions: NightlyRevenueBackfillException[] = [];
  for (const candidate of [...candidates].sort((a, b) =>
    a.guestBookingId.localeCompare(b.guestBookingId),
  )) {
    const planned = planBooking(candidate, options.allowInferredEqualAllocation, exceptions);
    const evidenceFingerprint = sha256(JSON.stringify(planned));
    lines.push(...planned.map((line) => ({ ...line, evidenceFingerprint })));
  }
  const sorted = lines.sort((a, b) =>
    `${a.propertyId}:${a.guestBookingId}:${a.stayDate}:${a.linePosition}`.localeCompare(
      `${b.propertyId}:${b.guestBookingId}:${b.stayDate}:${b.linePosition}`,
    ),
  );
  return {
    fingerprint: sha256(JSON.stringify({ lines: sorted, exceptions })),
    lines: sorted,
    exceptions,
    reconciliation: reconcile(sorted),
  };
}

function planBooking(
  candidate: NightlyRevenueBackfillCandidate,
  allowInference: boolean,
  exceptions: NightlyRevenueBackfillException[],
): Omit<NightlyRevenueBackfillLine, "evidenceFingerprint">[] {
  const issue = (
    code: NightlyRevenueBackfillException["code"],
    amounts?: NightlyRevenueBackfillException["amounts"],
  ) =>
    exceptions.push({
      propertyId: candidate.propertyId,
      guestBookingId: candidate.guestBookingId,
      code,
      amounts,
    });
  if (candidate.lifecycleStatus !== "confirmed" && candidate.lifecycleStatus !== "completed") {
    issue("non_recognizable_lifecycle");
    return [];
  }
  const lifecycleState = candidate.lifecycleStatus;
  const bookingDates = dates(candidate.checkIn, candidate.checkOut);
  const assignments = [...candidate.assignments].sort((a, b) => a.position - b.position);
  const scoped = assignments.map((assignment) => {
    const exactDates =
      candidate.retainedEvidence.exactNightly
        ?.filter(({ position }) => position === assignment.position)
        .map(({ stayDate }) => stayDate)
        .sort() ?? [];
    const indexes = exactDates.map((date) => bookingDates.indexOf(date));
    return {
      ...assignment,
      stayDates:
        assignment.stayEvidenceKind === "exact" && assignment.checkIn && assignment.checkOut
          ? dates(assignment.checkIn, assignment.checkOut)
          : exactDates.length > 0 &&
              indexes.every(
                (value, index) => value >= 0 && (!index || value === indexes[index - 1]! + 1),
              )
            ? exactDates
            : [],
    };
  });
  if (
    bookingDates.length === 0 ||
    !Number.isInteger(candidate.roomCount) ||
    candidate.roomCount < 1 ||
    assignments.length !== candidate.roomCount ||
    scoped.some(
      ({ position, roomTypeId, stayDates }, index) =>
        position !== index + 1 ||
        !roomTypeId ||
        stayDates.length === 0 ||
        stayDates.some((date) => !bookingDates.includes(date)),
    )
  ) {
    issue("invalid_booking_scope");
    return [];
  }
  const expectedKeys = scoped
    .flatMap(({ position, stayDates }) => stayDates.map((date) => key(date, position)))
    .sort();
  const covered = new Set(scoped.flatMap(({ stayDates }) => stayDates));
  if (bookingDates.some((date) => !covered.has(date))) issue("assignment_scope_mismatch");
  const retained = candidate.retainedEvidence;
  let quality: NightlyRevenueQuality = "missing";
  let amounts = new Map<string, string>();
  const hasRetainedAmount = retained.exactNightly !== undefined || retained.grossRoomTotal != null;
  if (hasRetainedAmount && retained.currency !== candidate.currency) issue("currency_mismatch");
  else if (retained.exactNightly !== undefined) {
    amounts = exactAmounts(retained.exactNightly, expectedKeys);
    if (amounts.size === expectedKeys.length) {
      quality = "exact";
      if (retained.grossRoomTotal != null) {
        const expected = parseMoney(retained.grossRoomTotal);
        const planned = [...amounts.values()].reduce(
          (sum, amount) => sum + parseMoney(amount)!,
          0n,
        );
        if (expected === null) issue("invalid_retained_total");
        else if (expected !== planned)
          issue("retained_total_mismatch", {
            expected: formatMoney(expected),
            planned: formatMoney(planned),
            delta: formatSignedMoney(planned - expected),
          });
      }
    } else {
      amounts.clear();
      issue("invalid_exact_evidence");
    }
  } else if (retained.grossRoomTotal != null) {
    const total = parseMoney(retained.grossRoomTotal);
    if (total === null) issue("invalid_retained_total");
    else if (!allowInference) issue("inference_not_approved");
    else {
      quality = "inferred";
      amounts = allocatedAmounts(total, expectedKeys);
    }
  } else issue("missing_evidence");
  return scoped.flatMap(({ position, roomTypeId, stayDates }) =>
    stayDates.map((stayDate) => ({
      propertyId: candidate.propertyId,
      guestBookingId: candidate.guestBookingId,
      roomTypeId,
      stayDate,
      currency: candidate.currency,
      grossRoomAmount: amounts.get(key(stayDate, position)) ?? null,
      linePosition: position,
      lifecycleState,
      sourceKind: candidate.sourceKind,
      evidenceQuality: quality,
    })),
  );
}

function exactAmounts(
  input: NightlyRevenueBackfillCandidate["retainedEvidence"]["exactNightly"],
  expectedKeys: string[],
): Map<string, string> {
  const expected = new Set(expectedKeys);
  const result = new Map<string, string>();
  for (const line of input ?? []) {
    const amount = parseMoney(line.grossRoomAmount);
    const lineKey = key(line.stayDate, line.position);
    if (!expected.has(lineKey) || amount === null || result.has(lineKey)) return new Map();
    result.set(lineKey, formatMoney(amount));
  }
  return result;
}

function allocatedAmounts(total: bigint, keys: string[]): Map<string, string> {
  const count = BigInt(keys.length);
  const base = total / count;
  const remainder = total % count;
  return new Map(
    keys.map((item, index) => [item, formatMoney(base + (BigInt(index) < remainder ? 1n : 0n))]),
  );
}

function reconcile(lines: NightlyRevenueBackfillLine[]) {
  const groups = new Map<string, NightlyRevenueBackfillLine[]>();
  for (const line of lines) {
    const id = `${line.propertyId}:${line.stayDate}:${line.currency}:${line.sourceKind}:${line.evidenceQuality}`;
    const group = groups.get(id) ?? [];
    group.push(line);
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const gross = group.reduce(
      (sum, { grossRoomAmount }) => sum + (parseMoney(grossRoomAmount ?? "0") ?? 0n),
      0n,
    );
    return {
      propertyId: first.propertyId,
      stayDate: first.stayDate,
      currency: first.currency,
      sourceKind: first.sourceKind,
      evidenceQuality: first.evidenceQuality,
      bookingCount: new Set(group.map(({ guestBookingId }) => guestBookingId)).size,
      evidenceRows: group.length,
      occupiedRoomNights: group.length,
      grossRoomAmount: formatMoney(gross),
      missingRows: group.filter(({ grossRoomAmount }) => grossRoomAmount === null).length,
    };
  });
}

function dates(from: string, to: string): string[] {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(from) || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(to))
    return [];
  const startMs = Date.parse(`${from}T00:00:00Z`),
    endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const start = new Date(startMs),
    end = new Date(endMs);
  if (
    start.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to ||
    from >= to
  )
    return [];
  const result: string[] = [];
  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000))
    result.push(cursor.toISOString().slice(0, 10));
  return result;
}

function parseMoney(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}
const formatMoney = (value: bigint) =>
  `${value / 10_000n}.${(value % 10_000n).toString().padStart(4, "0")}`;
const formatSignedMoney = (value: bigint) =>
  value < 0n ? `-${formatMoney(-value)}` : formatMoney(value);
const key = (stayDate: string, position: number) => `${stayDate}:${position}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
