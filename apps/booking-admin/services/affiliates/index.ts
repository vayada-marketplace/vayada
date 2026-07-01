export interface Affiliate {
  id: string;
  hotelId: string;
  referralCode: string;
  fullName: string;
  email: string;
  socialMedia: string;
  userType: "guest" | "creator";
  paymentMethod: "paypal" | "bank" | "stripe" | "xendit";
  paypalEmail: string;
  bankIban: string;
  bankAccountHolder: string;
  bankSwiftBic: string;
  bankName: string;
  bankCountry: string;
  defaultCommissionPct: number;
  commissionPctOverride: number | null;
  effectiveCommissionPct: number;
  status: "pending" | "approved" | "rejected" | "suspended";
  createdAt: string;
  updatedAt: string;
  bookingCount: number;
  totalRevenue: number;
  totalCommission: number;
  clickCount: number;
  conversionRate: number;
  stripeConnectAccountId: string | null;
  stripeConnectOnboarded: boolean;
  xenditChannelCode: string | null;
  xenditAccountNumber: string | null;
  xenditAccountHolderName: string | null;
}

export interface AffiliateListResponse {
  affiliates: Affiliate[];
  total: number;
  limit: number;
  offset: number;
}

export interface DefaultAffiliateCommission {
  defaultCommissionPct: number;
}

const AFFILIATE_ADMIN_UNAVAILABLE =
  "Booking Admin affiliate management is not available on the target API yet.";

export const affiliatesService = {
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    void params;
    return unavailableAffiliateAdmin<AffiliateListResponse>();
  },

  get: (id: string) => {
    void id;
    return unavailableAffiliateAdmin<Affiliate>();
  },

  updateStatus: (id: string, status: "approved" | "rejected" | "suspended") => {
    void id;
    void status;
    return unavailableAffiliateAdmin<Affiliate>();
  },

  updateCommission: (id: string, commissionPct: number | null) => {
    void id;
    void commissionPct;
    return unavailableAffiliateAdmin<Affiliate>();
  },

  getDefaultCommission: () => unavailableAffiliateAdmin<DefaultAffiliateCommission>(),

  updateDefaultCommission: (defaultCommissionPct: number) => {
    void defaultCommissionPct;
    return unavailableAffiliateAdmin<DefaultAffiliateCommission>();
  },
};

function unavailableAffiliateAdmin<T>(): Promise<T> {
  return Promise.reject(new Error(AFFILIATE_ADMIN_UNAVAILABLE));
}
