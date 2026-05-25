import { pmsClient } from "../api/pmsClient";
import { buildQueryString } from "@/lib/utils/queryString";

export type InvoiceStatus = "draft" | "sent" | "paid" | "partial" | "overdue" | "voided";

export type ManualPaymentMethod = "cash" | "bank_transfer" | "manual_card" | "other";

export interface InvoiceListItem {
  id: string;
  invoiceNumber: string;
  bookingId: string;
  bookingReference: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  roomNumber: string | null;
  roomName: string;
  currency: string;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: InvoiceStatus;
  issuedAt: string;
}

export interface InvoiceListResponse {
  invoices: InvoiceListItem[];
  total: number;
  counts: Record<InvoiceStatus, number>;
  limit: number;
  offset: number;
}

export interface InvoiceCharge {
  description: string;
  detail: string;
  amount: number;
}

export interface InvoicePayment {
  id: string;
  method: string;
  methodLabel: string;
  amount: number;
  currency: string;
  reference: string | null;
  status: string;
  recordedAt: string;
}

export interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  bookingId: string;
  bookingReference: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  roomNumber: string | null;
  roomName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  charges: InvoiceCharge[];
  subtotal: number;
  totalAmount: number;
  payments: InvoicePayment[];
  amountPaid: number;
  balanceDue: number;
  status: InvoiceStatus;
  issuedAt: string;
}

export interface FinancialsSummary {
  revenueMtd: number;
  revenueMtdDeltaPct: number | null;
  outstanding: number;
  overdueCount: number;
  currency: string;
}

export interface PaymentLedgerEntry {
  id: string;
  invoiceNumber: string;
  bookingId: string;
  bookingReference: string;
  guestFirstName: string;
  guestLastName: string;
  method: string;
  methodLabel: string;
  amount: number;
  currency: string;
  reference: string | null;
  status: string;
  recordedAt: string;
}

export interface PaymentLedgerResponse {
  payments: PaymentLedgerEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordPaymentRequest {
  amount: number;
  paymentMethod: ManualPaymentMethod;
  reference?: string;
}

export const financialsService = {
  summary: () => pmsClient.get<FinancialsSummary>("/admin/financials/summary"),

  listInvoices: (params?: {
    status?: InvoiceStatus;
    search?: string;
    sort?: "date" | "guest" | "amount";
    limit?: number;
    offset?: number;
  }) => {
    const qs = buildQueryString(params);
    return pmsClient.get<InvoiceListResponse>(`/admin/financials/invoices${qs}`);
  },

  getInvoice: (bookingId: string) =>
    pmsClient.get<InvoiceDetail>(`/admin/financials/invoices/${bookingId}`),

  recordPayment: (bookingId: string, data: RecordPaymentRequest) =>
    pmsClient.post<InvoiceDetail>(`/admin/financials/invoices/${bookingId}/payments`, data),

  listPayments: (params?: { limit?: number; offset?: number }) => {
    const qs = buildQueryString(params);
    return pmsClient.get<PaymentLedgerResponse>(`/admin/financials/payments${qs}`);
  },

  exportCsvUrl: (params?: { status?: InvoiceStatus; search?: string }) => {
    const qs = buildQueryString(params);
    const base = process.env.NEXT_PUBLIC_PMS_API_URL || "https://api.pms.localhost";
    return `${base}/admin/financials/invoices/export.csv${qs}`;
  },
};
