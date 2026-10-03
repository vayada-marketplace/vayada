export const PROPERTY_PROFILE_CHANNEL_TYPES = [
  "email",
  "phone",
  "website",
  "whatsapp",
  "instagram",
  "facebook",
  "x",
] as const;

export const PROPERTY_PROFILE_CONTACT_PURPOSES = [
  "general",
  "operations",
  "guest",
  "creator",
] as const;

export const PROPERTY_PROFILE_MAP_DISPLAY_MODES = ["hidden", "approximate", "exact"] as const;

export type PropertyProfileChannelType = (typeof PROPERTY_PROFILE_CHANNEL_TYPES)[number];
export type PropertyProfileContactPurpose = (typeof PROPERTY_PROFILE_CONTACT_PURPOSES)[number];
export type PropertyProfileMapDisplayMode = (typeof PROPERTY_PROFILE_MAP_DISPLAY_MODES)[number];

export type PropertyProfileLocation = {
  streetAddress: string;
  postalCode: string;
  city: string;
  countryCode: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  localityPublic: boolean;
  geoPublic: boolean;
  mapDisplayMode: PropertyProfileMapDisplayMode;
};

export type PropertyProfileContact = {
  channelType: PropertyProfileChannelType;
  value: string;
  purpose: PropertyProfileContactPurpose;
  isPublic: boolean;
};

export type PropertyProfile = {
  displayName: string;
  propertyType: string;
  location: PropertyProfileLocation;
  contacts: PropertyProfileContact[];
};

export type PropertyInitialLaunchSettings = {
  defaultCurrency: string;
  supportedCurrencies: string[];
  defaultLanguage: string;
  supportedLanguages: string[];
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
};

export type CreatePropertyProfileRequest = PropertyProfile & {
  initialLaunchSettings?: PropertyInitialLaunchSettings;
};

export type PropertyProfilePatch = {
  displayName?: string;
  propertyType?: string;
  location?: Partial<PropertyProfileLocation>;
  contacts?: PropertyProfileContact[];
};

export type UpdatePropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: PropertyProfilePatch;
};

export type PropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  profile: PropertyProfile;
};

export function parseCreatePropertyProfileRequest(
  value: unknown,
): CreatePropertyProfileRequest | null {
  if (!isRecord(value)) return null;
  const { initialLaunchSettings, ...profile } = value;
  if (!isPropertyProfile(profile)) return null;
  if (
    Object.hasOwn(value, "initialLaunchSettings") &&
    !isInitialLaunchSettings(initialLaunchSettings)
  )
    return null;
  return value as CreatePropertyProfileRequest;
}

function isInitialLaunchSettings(value: unknown): value is PropertyInitialLaunchSettings {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "defaultCurrency",
      "supportedCurrencies",
      "defaultLanguage",
      "supportedLanguages",
      "instagram",
      "facebook",
      "tiktok",
      "youtube",
    ])
  )
    return false;
  const currency = (code: unknown) => typeof code === "string" && /^[A-Z]{3}$/i.test(code.trim());
  const language = (code: unknown) =>
    typeof code === "string" && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(code.trim());
  const social = (url: unknown) => {
    if (typeof url !== "string") return false;
    if (!url.trim()) return true;
    try {
      const parsed = new URL(url.trim());
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        Boolean(parsed.hostname) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  };
  return (
    currency(value.defaultCurrency) &&
    language(value.defaultLanguage) &&
    Array.isArray(value.supportedCurrencies) &&
    value.supportedCurrencies.every(currency) &&
    Array.isArray(value.supportedLanguages) &&
    value.supportedLanguages.every(language) &&
    ["instagram", "facebook", "tiktok", "youtube"].every((key) => social(value[key]))
  );
}

export function parsePropertyProfileResponse(value: unknown): PropertyProfileResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["propertyId", "profileRevision", "profile"])) {
    return null;
  }
  const propertyId = value["propertyId"];
  const profileRevision = value["profileRevision"];
  const profile = value["profile"];
  if (
    typeof propertyId !== "string" ||
    !propertyId ||
    !Number.isSafeInteger(profileRevision) ||
    (profileRevision as number) < 1 ||
    !isReadablePropertyProfile(profile)
  ) {
    return null;
  }
  return value as PropertyProfileResponse;
}

// Stored draft profiles keep the complete response shape while required facts
// are still being collected. Writes remain strict; reads accept empty strings
// so an incomplete property can be reopened and completed by the wizard.
function isReadablePropertyProfile(value: unknown): value is PropertyProfile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "propertyType", "location", "contacts"])
  ) {
    return false;
  }
  return (
    typeof value["displayName"] === "string" &&
    typeof value["propertyType"] === "string" &&
    isReadablePropertyProfileLocation(value["location"]) &&
    Array.isArray(value["contacts"]) &&
    value["contacts"].every(isPropertyProfileContact)
  );
}

function isReadablePropertyProfileLocation(value: unknown): value is PropertyProfileLocation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "streetAddress",
      "postalCode",
      "city",
      "countryCode",
      "timezone",
      "latitude",
      "longitude",
      "localityPublic",
      "geoPublic",
      "mapDisplayMode",
    ])
  ) {
    return false;
  }
  return (
    ["streetAddress", "postalCode", "city", "countryCode", "timezone"].every(
      (key) => typeof value[key] === "string",
    ) &&
    isNullableFiniteNumber(value["latitude"]) &&
    isNullableFiniteNumber(value["longitude"]) &&
    typeof value["localityPublic"] === "boolean" &&
    typeof value["geoPublic"] === "boolean" &&
    PROPERTY_PROFILE_MAP_DISPLAY_MODES.includes(
      value["mapDisplayMode"] as PropertyProfileMapDisplayMode,
    )
  );
}

export function parseUpdatePropertyProfileRequest(
  value: unknown,
): UpdatePropertyProfileRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["expectedProfileRevision", "patch"])) {
    return null;
  }
  const expectedProfileRevision = value["expectedProfileRevision"];
  const patch = value["patch"];
  if (
    !Number.isSafeInteger(expectedProfileRevision) ||
    (expectedProfileRevision as number) < 1 ||
    !isPropertyProfilePatch(patch)
  ) {
    return null;
  }
  return value as UpdatePropertyProfileRequest;
}

function isPropertyProfile(value: unknown): value is PropertyProfile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "propertyType", "location", "contacts"])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value["displayName"]) &&
    isNonEmptyString(value["propertyType"]) &&
    isPropertyProfileLocation(value["location"]) &&
    Array.isArray(value["contacts"]) &&
    value["contacts"].every(isPropertyProfileContact)
  );
}

function isPropertyProfileLocation(value: unknown): value is PropertyProfileLocation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "streetAddress",
      "postalCode",
      "city",
      "countryCode",
      "timezone",
      "latitude",
      "longitude",
      "localityPublic",
      "geoPublic",
      "mapDisplayMode",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value["streetAddress"]) &&
    isNonEmptyString(value["postalCode"]) &&
    isNonEmptyString(value["city"]) &&
    isNonEmptyString(value["countryCode"]) &&
    isNonEmptyString(value["timezone"]) &&
    isNullableFiniteNumber(value["latitude"]) &&
    isNullableFiniteNumber(value["longitude"]) &&
    typeof value["localityPublic"] === "boolean" &&
    typeof value["geoPublic"] === "boolean" &&
    PROPERTY_PROFILE_MAP_DISPLAY_MODES.includes(
      value["mapDisplayMode"] as PropertyProfileMapDisplayMode,
    )
  );
}

function isPropertyProfileContact(value: unknown): value is PropertyProfileContact {
  if (!isRecord(value) || !hasOnlyKeys(value, ["channelType", "value", "purpose", "isPublic"])) {
    return false;
  }
  return (
    PROPERTY_PROFILE_CHANNEL_TYPES.includes(value["channelType"] as PropertyProfileChannelType) &&
    isNonEmptyString(value["value"]) &&
    PROPERTY_PROFILE_CONTACT_PURPOSES.includes(value["purpose"] as PropertyProfileContactPurpose) &&
    typeof value["isPublic"] === "boolean"
  );
}

function isPropertyProfilePatch(value: unknown): value is PropertyProfilePatch {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !hasOnlyKeys(value, ["displayName", "propertyType", "location", "contacts"])
  ) {
    return false;
  }
  if (value["displayName"] !== undefined && !isNonEmptyString(value["displayName"])) return false;
  if (value["propertyType"] !== undefined && !isNonEmptyString(value["propertyType"])) return false;
  if (value["contacts"] !== undefined) {
    if (!Array.isArray(value["contacts"]) || !value["contacts"].every(isPropertyProfileContact)) {
      return false;
    }
  }
  if (value["location"] !== undefined) {
    const location = value["location"];
    if (
      !isRecord(location) ||
      Object.keys(location).length === 0 ||
      !hasOnlyKeys(location, [
        "streetAddress",
        "postalCode",
        "city",
        "countryCode",
        "timezone",
        "latitude",
        "longitude",
        "localityPublic",
        "geoPublic",
        "mapDisplayMode",
      ])
    ) {
      return false;
    }
    for (const key of ["streetAddress", "postalCode", "city", "countryCode", "timezone"]) {
      if (location[key] !== undefined && !isNonEmptyString(location[key])) return false;
    }
    for (const key of ["latitude", "longitude"]) {
      if (location[key] !== undefined && !isNullableFiniteNumber(location[key])) return false;
    }
    for (const key of ["localityPublic", "geoPublic"]) {
      if (location[key] !== undefined && typeof location[key] !== "boolean") return false;
    }
    if (
      location["mapDisplayMode"] !== undefined &&
      !PROPERTY_PROFILE_MAP_DISPLAY_MODES.includes(
        location["mapDisplayMode"] as PropertyProfileMapDisplayMode,
      )
    ) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
