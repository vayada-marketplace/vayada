/**
 * One ApiClient class, instantiated once per backend:
 *   - bookingEngine: marketing/CMS backend at NEXT_PUBLIC_API_URL
 *   - pms:           reservations/inventory backend at NEXT_PUBLIC_PMS_URL
 *
 * The two backends serve different routes (hotel info & promo codes live on
 * the booking engine; rooms, bookings, and payment settings live on the PMS),
 * so callers must pick the right namespace. The PMS_URL falls back to the
 * booking-engine URL for environments where one process serves both.
 */

class ApiError extends Error {
  status: number
  detail: unknown
  constructor(message: string, status: number, detail: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

class ApiClient {
  constructor(private baseUrl: string) {}

  get baseURL(): string {
    return this.baseUrl
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    return parse<T>(res, 'GET')
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    return parse<T>(res, 'POST')
  }
}

async function parse<T>(res: Response, method: string): Promise<T> {
  if (!res.ok) {
    let detail: unknown = null
    try { detail = await res.json() } catch {}
    const message = (detail && typeof detail === 'object' && 'detail' in detail && typeof (detail as any).detail === 'string')
      ? (detail as any).detail
      : `API error: ${method} ${res.status} ${res.statusText}`
    throw new ApiError(message, res.status, detail)
  }
  return res.json()
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || ''
const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || API_URL

export const bookingEngine = new ApiClient(API_URL)
export const pms = new ApiClient(PMS_URL)
export { ApiError }
