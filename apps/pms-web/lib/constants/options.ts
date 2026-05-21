export interface CurrencyOption {
  code: string
  name: string
  flag: string
}

// Kept in sync with the booking-engine admin's CURRENCY_OPTIONS so the
// PMS and BE Admin currency dropdowns offer the same set of choices.
export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: 'AUD', name: 'Australian Dollar', flag: '\u{1F1E6}\u{1F1FA}' },
  { code: 'BRL', name: 'Brazilian Real', flag: '\u{1F1E7}\u{1F1F7}' },
  { code: 'GBP', name: 'British Pound', flag: '\u{1F1EC}\u{1F1E7}' },
  { code: 'BGN', name: 'Bulgarian Lev', flag: '\u{1F1E7}\u{1F1EC}' },
  { code: 'CAD', name: 'Canadian Dollar', flag: '\u{1F1E8}\u{1F1E6}' },
  { code: 'CNY', name: 'Chinese Yuan', flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'HRK', name: 'Croatian Kuna', flag: '\u{1F1ED}\u{1F1F7}' },
  { code: 'CZK', name: 'Czech Koruna', flag: '\u{1F1E8}\u{1F1FF}' },
  { code: 'DKK', name: 'Danish Krone', flag: '\u{1F1E9}\u{1F1F0}' },
  { code: 'EUR', name: 'Euro', flag: '\u{1F1EA}\u{1F1FA}' },
  { code: 'HKD', name: 'Hong Kong Dollar', flag: '\u{1F1ED}\u{1F1F0}' },
  { code: 'HUF', name: 'Hungarian Forint', flag: '\u{1F1ED}\u{1F1FA}' },
  { code: 'INR', name: 'Indian Rupee', flag: '\u{1F1EE}\u{1F1F3}' },
  { code: 'IDR', name: 'Indonesian Rupiah', flag: '\u{1F1EE}\u{1F1E9}' },
  { code: 'JPY', name: 'Japanese Yen', flag: '\u{1F1EF}\u{1F1F5}' },
  { code: 'MXN', name: 'Mexican Peso', flag: '\u{1F1F2}\u{1F1FD}' },
  { code: 'NZD', name: 'New Zealand Dollar', flag: '\u{1F1F3}\u{1F1FF}' },
  { code: 'NOK', name: 'Norwegian Krone', flag: '\u{1F1F3}\u{1F1F4}' },
  { code: 'PLN', name: 'Polish Zloty', flag: '\u{1F1F5}\u{1F1F1}' },
  { code: 'RON', name: 'Romanian Leu', flag: '\u{1F1F7}\u{1F1F4}' },
  { code: 'RUB', name: 'Russian Ruble', flag: '\u{1F1F7}\u{1F1FA}' },
  { code: 'SGD', name: 'Singapore Dollar', flag: '\u{1F1F8}\u{1F1EC}' },
  { code: 'SEK', name: 'Swedish Krona', flag: '\u{1F1F8}\u{1F1EA}' },
  { code: 'CHF', name: 'Swiss Franc', flag: '\u{1F1E8}\u{1F1ED}' },
  { code: 'THB', name: 'Thai Baht', flag: '\u{1F1F9}\u{1F1ED}' },
  { code: 'TRY', name: 'Turkish Lira', flag: '\u{1F1F9}\u{1F1F7}' },
  { code: 'AED', name: 'UAE Dirham', flag: '\u{1F1E6}\u{1F1EA}' },
  { code: 'USD', name: 'US Dollar', flag: '\u{1F1FA}\u{1F1F8}' },
]
