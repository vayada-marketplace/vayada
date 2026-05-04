export const TIMEZONE_OPTIONS = [
  'UTC',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
]

export interface CurrencyOption {
  code: string
  name: string
  flag: string
}

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

export const POPULAR_CURRENCY_CODES = ['EUR', 'GBP', 'AUD', 'SGD', 'CHF', 'CAD', 'THB', 'JPY']

export interface LanguageOption {
  code: string
  name: string
  nativeName: string
  flag: string
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: 'en', name: 'English', nativeName: 'English', flag: '\u{1F1EC}\u{1F1E7}' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '\u{1F1E9}\u{1F1EA}' },
  { code: 'fr', name: 'French', nativeName: 'Fran\u00e7ais', flag: '\u{1F1EB}\u{1F1F7}' },
  { code: 'es', name: 'Spanish', nativeName: 'Espa\u00f1ol', flag: '\u{1F1EA}\u{1F1F8}' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '\u{1F1EE}\u{1F1E9}' },
  { code: 'ja', name: 'Japanese', nativeName: '\u65E5\u672C\u8A9E', flag: '\u{1F1EF}\u{1F1F5}' },
  { code: 'zh', name: 'Chinese', nativeName: '\u4E2D\u6587', flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'ru', name: 'Russian', nativeName: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439', flag: '\u{1F1F7}\u{1F1FA}' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '\u{1F1EE}\u{1F1F9}' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', flag: '\u{1F1F3}\u{1F1F1}' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '\u{1F1F0}\u{1F1F7}' },
]

export const POPULAR_LANGUAGE_CODES = ['id', 'de', 'fr', 'es', 'ja', 'ru']
