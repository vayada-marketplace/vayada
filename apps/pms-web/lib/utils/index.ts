import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  INR: "₹",
  THB: "฿",
  IDR: "IDR ",
  MYR: "RM",
  PHP: "₱",
  VND: "₫",
  SGD: "S$",
  AUD: "A$",
  NZD: "NZ$",
  CAD: "C$",
  CHF: "CHF",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  HKD: "HK$",
  TWD: "NT$",
  ZAR: "R",
  BRL: "R$",
  MXN: "MX$",
  AED: "AED",
  SAR: "SAR",
  TRY: "₺",
  PLN: "zł",
  CZK: "Kč",
  HUF: "Ft",
  RON: "lei",
  HRK: "kn",
  RUB: "₽",
  ILS: "₪",
  EGP: "E£",
  MAD: "MAD",
  KES: "KSh",
  NGN: "₦",
  GHS: "GH₵",
  COP: "COL$",
  PEN: "S/.",
  CLP: "CLP$",
  ARS: "ARS$",
};

export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || currency;
}

export function formatCurrency(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function formatCompactPrice(amount: number, currency: string): string {
  const symbol = getCurrencySymbol(currency);
  if (!Number.isFinite(amount)) return `${symbol}0`;
  const compact = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
  return `${symbol}${compact}`;
}
