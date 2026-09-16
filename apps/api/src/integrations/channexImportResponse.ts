/** Shared bounded reader for the import-only Channex transports. */
export async function readChannexImportResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Channex import request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) throw new Error("Channex import response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
