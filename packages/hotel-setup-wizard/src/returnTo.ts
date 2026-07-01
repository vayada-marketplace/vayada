export type ReturnToParam = string | string[] | null | undefined;

export function firstSearchParam(value: ReturnToParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
