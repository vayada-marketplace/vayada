/** English text of the first pricing setup; the PMS app supplies the same keys in its own catalogs. */
export const firstPricingSetupEnglish = {
  "pricing.cancellationPolicy": "Cancellation policy",
  "pricing.choose": "Choose…",
  "pricing.error.cancellationDeadline": "Check the cancellation deadline (0–365 days).",
  "pricing.error.invalidPrice": "Enter a valid price using a decimal point.",
  "pricing.error.paymentMethodRequired": "Choose at least one accepted payment method.",
  "pricing.error.priceTooLarge": "This price is too large.",
  "pricing.error.priceZero": "Enter a price greater than zero.",
  "pricing.error.unverified": "Pricing data could not be verified. Reload before continuing.",
  "pricing.freeCancellationDays": "Free cancellation until days before arrival (0–365)",
  "pricing.freeCancellationUntilDeadline": "Free cancellation until a deadline",
  "pricing.fullPayment": "Full payment",
  "pricing.included.adults": "Adults included in the base price",
  "pricing.included.amount.one": "Adjustment for {count} adult",
  "pricing.included.amount.other": "Adjustment for {count} adults",
  "pricing.included.baseRow.one": "{count} adult: base price, no adjustment.",
  "pricing.included.baseRow.other": "{count} adults: base price, no adjustment.",
  "pricing.included.errorAdjustment":
    "Enter an adjustment and choose its type for every other adult count.",
  "pricing.included.errorAdults": "Choose the number of adults included in the base price.",
  "pricing.included.errorPercentage": "This percentage is outside the supported range.",
  "pricing.included.errorRange":
    "Every adjusted room price must be positive and within the supported amount range.",
  "pricing.included.fixed": "Amount in the selected currency",
  "pricing.included.forLabel": "{text} for {label}",
  "pricing.included.hint":
    "Each adjustment applies once to the same base price. For a base of 130 including two adults, enter -30 for one adult and +25 for three adults to charge 100, 130 and 155. Use a minus sign for a reduction; 0 means the same price. Child charges are added separately.",
  "pricing.included.percentage": "Percentage of the base price",
  "pricing.included.type.one": "Adjustment type for {count} adult",
  "pricing.included.type.other": "Adjustment type for {count} adults",
  "pricing.nonRefundable": "Non-refundable",
  "pricing.paymentMethods.card": "Card online",
  "pricing.paymentMethods.hint":
    "Only payment methods ready in Payment settings can be used at checkout.",
  "pricing.paymentMethods.legend": "Accepted payment methods",
  "pricing.paymentMethods.payAtProperty": "Pay at property",
  "pricing.paymentPolicy": "Payment policy",
  "pricing.setup.adultAge": "Adult pricing starts at age (1–18)",
  "pricing.setup.adultPrice": "Price per adult per night",
  "pricing.setup.ageHint":
    "Guests at or above the adult-pricing age use adult prices. Younger guests use the separate child price, even when they count toward capacity. An occupancy price is the room total for that adult count; a per-adult price is multiplied by the adult count. Child charges are added separately.",
  "pricing.setup.capacity":
    "Room capacity: {total} total, up to {adults} adults and {children} children.",
  "pricing.setup.childBand":
    "One child band covers age 0 through the year before adult pricing starts.",
  "pricing.setup.childPrice": "Price per child per night (0 is allowed)",
  "pricing.setup.continue": "Continue to draft",
  "pricing.setup.continueHint":
    "Continue saves the offer’s policy and checks pricing readiness. The policy remains saved if a later check fails. You must still save a draft, review charges and approve pricing. Nothing is sent to channels.",
  "pricing.setup.countChildren": "Children count toward room capacity",
  "pricing.setup.currency": "Currency code (for example EUR)",
  "pricing.setup.errorCheck": "Check the pricing settings.",
  "pricing.setup.errorConfiguration": "Check the ages, stay limits, capacity and prices.",
  "pricing.setup.errorExistingRoom": "Keep the existing room and pricing currency.",
  "pricing.setup.errorIncomplete": "Complete every required pricing and policy setting.",
  "pricing.setup.errorMode": "Choose how to price this room.",
  "pricing.setup.errorOccupancy": "Enter a price for every adult count.",
  "pricing.setup.errorRoom": "Choose a room type.",
  "pricing.setup.existingBands":
    "The existing child age bands and charges apply to this offer and remain unchanged.",
  "pricing.setup.intro":
    "Start with one room-only offer: the chosen prices apply every night, no calendar exceptions, and arrivals, departures and sales open. Only active rooms with complete capacity settings are listed. You can edit the pricing rules after setup.",
  "pricing.setup.maximum": "Maximum stay in nights (blank means unlimited)",
  "pricing.setup.minimum": "Minimum stay in nights",
  "pricing.setup.mode": "How is the room priced?",
  "pricing.setup.modeFlat": "One price per room",
  "pricing.setup.modeIncluded": "Base price with adult-count adjustments",
  "pricing.setup.modeOccupancy": "Price for each adult count",
  "pricing.setup.modePerPerson": "Price per adult",
  "pricing.setup.no": "No",
  "pricing.setup.noRooms":
    "No active room types with complete capacity settings are available. Complete room setup first.",
  "pricing.setup.occupancyPrice.one": "Room price for {count} adult per night",
  "pricing.setup.occupancyPrice.other": "Room price for {count} adults per night",
  "pricing.setup.penalty":
    "After the cancellation deadline and for no-shows, the penalty is the full booking amount.",
  "pricing.setup.room": "Room: {name}",
  "pricing.setup.roomPrice": "Room price per night",
  "pricing.setup.roomType": "Room type",
  "pricing.setup.titleAnotherRoom": "Add another room price",
  "pricing.setup.titleFirst": "Create your first room price",
  "pricing.setup.titleOffer": "Create an independent offer",
  "pricing.setup.yes": "Yes",
} as const;

export type FirstPricingSetupMessageKey = keyof typeof firstPricingSetupEnglish;
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Translates with the English setup text, for apps without a PMS catalog. */
export const englishPricingSetup: Translate = (key, params = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (firstPricingSetupEnglish as Record<string, string>)[key] ?? key,
  );
