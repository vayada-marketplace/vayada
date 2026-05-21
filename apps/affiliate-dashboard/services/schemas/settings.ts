import { z } from 'zod'

export const PAYMENT_METHODS = ['stripe', 'xendit', 'paypal', 'bank'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const XENDIT_BANKS = [
  { code: 'ID_BCA', name: 'BCA' },
  { code: 'ID_MANDIRI', name: 'Mandiri' },
  { code: 'ID_BNI', name: 'BNI' },
  { code: 'ID_BRI', name: 'BRI' },
  { code: 'ID_PERMATA', name: 'Permata' },
  { code: 'ID_CIMB', name: 'CIMB Niaga' },
] as const

export const settingsSchema = z
  .object({
    paymentMethod: z.enum(PAYMENT_METHODS),
    paypalEmail: z.string(),
    bankIban: z.string(),
    bankAccountHolder: z.string(),
    bankSwiftBic: z.string(),
    bankName: z.string(),
    bankCountry: z.string(),
    xenditChannelCode: z.string(),
    xenditAccountNumber: z.string(),
    xenditAccountHolderName: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMethod === 'paypal') {
      if (!data.paypalEmail.trim()) {
        ctx.addIssue({ path: ['paypalEmail'], code: 'custom', message: 'PayPal email is required' })
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.paypalEmail.trim())) {
        ctx.addIssue({ path: ['paypalEmail'], code: 'custom', message: 'Enter a valid email address' })
      }
    }
    if (data.paymentMethod === 'bank') {
      if (!data.bankAccountHolder.trim()) {
        ctx.addIssue({ path: ['bankAccountHolder'], code: 'custom', message: 'Account holder name is required' })
      }
      if (!data.bankIban.trim()) {
        ctx.addIssue({ path: ['bankIban'], code: 'custom', message: 'IBAN / account number is required' })
      }
      if (!data.bankSwiftBic.trim()) {
        ctx.addIssue({ path: ['bankSwiftBic'], code: 'custom', message: 'SWIFT / BIC is required' })
      }
      if (!data.bankName.trim()) {
        ctx.addIssue({ path: ['bankName'], code: 'custom', message: 'Bank name is required' })
      }
      if (!data.bankCountry.trim()) {
        ctx.addIssue({ path: ['bankCountry'], code: 'custom', message: 'Bank country is required' })
      }
    }
    if (data.paymentMethod === 'xendit') {
      const acct = data.xenditAccountNumber.trim()
      if (!acct) {
        ctx.addIssue({ path: ['xenditAccountNumber'], code: 'custom', message: 'Account number is required' })
      } else if (!/^\d{5,20}$/.test(acct)) {
        ctx.addIssue({ path: ['xenditAccountNumber'], code: 'custom', message: 'Account number must be 5-20 digits' })
      }
      if (!data.xenditAccountHolderName.trim()) {
        ctx.addIssue({ path: ['xenditAccountHolderName'], code: 'custom', message: 'Account holder name is required' })
      }
    }
  })

export type SettingsFormValues = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: SettingsFormValues = {
  paymentMethod: 'stripe',
  paypalEmail: '',
  bankIban: '',
  bankAccountHolder: '',
  bankSwiftBic: '',
  bankName: '',
  bankCountry: '',
  xenditChannelCode: 'ID_BCA',
  xenditAccountNumber: '',
  xenditAccountHolderName: '',
}
