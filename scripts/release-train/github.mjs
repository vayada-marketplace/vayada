// A small GitHub REST/GraphQL client for the release train (VAY-2311). Every call has its own
// timeout, and reads are retried: on 2026-10-21/22 API blips ("error connecting to
// api.github.com") left the laptop scripts hanging for over an hour after a deploy finished.

// The longest wait a rate limit may impose before the next try; a reset further away still
// gets its retries, and fails if the limit outlasts them.
const MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;

export class HttpError extends Error {
  constructor(method, path, status, detail, headers, now = Date.now()) {
    super(`${method} ${path}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.status = status;
    // GitHub marks rate limits with headers, never only in the body: retry-after (secondary
    // limits, 429) or x-ratelimit-remaining 0 with the reset time (primary limit).
    const retryAfter = Number(headers?.get("retry-after"));
    const reset = Number(headers?.get("x-ratelimit-reset"));
    this.rateLimited = retryAfter > 0 || headers?.get("x-ratelimit-remaining") === "0";
    this.waitMs =
      retryAfter > 0
        ? retryAfter * 1000
        : this.rateLimited && reset > 0
          ? Math.max(0, reset * 1000 - now)
          : 0;
  }
}

// Worth another try: rate limits, server errors and network failures (including our own
// timeout). Any other 4xx answer is final.
function retryable(error) {
  if (!(error instanceof HttpError)) return true;
  if (error.status === 403) return error.rateLimited;
  return error.status === 429 || error.status >= 500;
}

export function createGitHub({
  token,
  api = "https://api.github.com",
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30_000,
  attempts = 6,
  log = () => {},
  now = Date.now,
}) {
  if (!token) throw new Error("a GitHub token is required");

  async function once(method, path, { body, raw = false, accept } = {}) {
    const url = path.startsWith("https://") ? path : `${api}${path}`;
    const headers = {
      accept: accept ?? "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpError(
        method,
        path,
        response.status,
        text.slice(0, 200),
        response.headers,
        now(),
      );
    }
    if (raw) return Buffer.from(await response.arrayBuffer());
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // Reads (and writes that are safe to repeat) retry with backoff; `retry: false` sends once,
  // for writes whose duplicate would do harm, such as starting a second workflow run.
  async function request(method, path, options = {}) {
    const tries = options.retry === false ? 1 : attempts;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(method, path, options);
      } catch (error) {
        if (attempt >= tries || !retryable(error)) throw error;
        log(`${method} ${path} failed (${error.message}); retry ${attempt}/${tries - 1}`);
        const backoff = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
        await sleep(Math.max(backoff, Math.min(error.waitMs ?? 0, MAX_RATE_LIMIT_WAIT_MS)));
      }
    }
  }

  return {
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options) => request("POST", path, { ...options, body }),
    patch: (path, body, options) => request("PATCH", path, { ...options, body }),
    async graphql(query, variables = {}) {
      const result = await request("POST", "/graphql", { body: { query, variables } });
      if (result?.errors?.length) throw new Error(`GraphQL: ${result.errors[0].message}`);
      return result.data;
    },
  };
}
