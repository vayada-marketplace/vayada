/** Headers have already arrived. The dispatcher must separately bound fetch itself. */
export async function readChannexResponse<T extends { outcome: string }>(
  response: Response,
  sanitize: (input: { httpStatus: number; providerRequestId: string | null; body: string }) => T,
) {
  const metadata = {
    httpStatus: response.status,
    providerRequestId: response.headers.get("x-request-id"),
  };
  const empty = sanitize({ ...metadata, body: "" });
  const interrupted = { ...empty, outcome: "body_interrupted" as const };
  if (response.bodyUsed || response.body?.locked) return interrupted;
  if (!response.body) return empty;
  const reader = response.body.getReader();
  const expiresAt = performance.now() + 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  const deadline = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), 5000);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  const consume = async () => {
    while (true) {
      if (performance.now() >= expiresAt) return interrupted;
      const chunk = await reader.read();
      if (performance.now() >= expiresAt) return interrupted;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) return { ...empty, outcome: "body_limit" as const };
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return sanitize({ ...metadata, body });
  };
  try {
    const result = await Promise.race([consume(), deadline]);
    return result === expired ? interrupted : result;
  } catch {
    return interrupted;
  } finally {
    clearTimeout(timer);
    // Cancellation is best-effort: a stalled source must not extend the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
