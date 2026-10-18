import {
  createProductReadinessResult,
  type ProductReadinessResult,
  type ReadinessProduct,
} from "./onboardingReadiness.js";

declare const bookingContentRevisionId: unique symbol;
declare const readyProductReadinessEvidence: unique symbol;
declare const liveAriSourceRevision: unique symbol;

export type BookingContentRevisionId = string & {
  readonly [bookingContentRevisionId]: true;
};

export type OnboardingLifecycleJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly OnboardingLifecycleJsonValue[]
  | { readonly [key: string]: OnboardingLifecycleJsonValue };

export type OnboardingLifecycleJsonObject = {
  readonly [key: string]: OnboardingLifecycleJsonValue;
};

type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export type ReadyProductReadinessEvidence<TProduct extends ReadinessProduct> = DeepReadonly<
  Pick<
    ProductReadinessResult,
    "contractVersion" | "propertyId" | "sourceManifest" | "sourceManifestHash" | "readinessHash"
  > & {
    product: TProduct;
    status: "ready";
  }
> & {
  readonly [readyProductReadinessEvidence]: TProduct;
};

/**
 * Recomputes both hashes before creating detached, deeply frozen evidence.
 * The brand prevents callers from accidentally constructing evidence from
 * unverified hash-shaped objects.
 */
export async function createReadyProductReadinessEvidence<TProduct extends ReadinessProduct>(
  result: ProductReadinessResult,
  expected: Readonly<{ propertyId: string; product: TProduct }>,
): Promise<ReadyProductReadinessEvidence<TProduct>> {
  if (result.outcome !== "evaluated" || result.status !== "ready") {
    throw new Error("Publication lifecycle evidence requires a ready evaluation");
  }
  if (result.propertyId !== expected.propertyId) {
    throw new Error("Publication lifecycle evidence identifies a different property");
  }
  if (result.product !== expected.product) {
    throw new Error("Publication lifecycle evidence identifies a different product");
  }

  const verified = await createProductReadinessResult({
    contractVersion: result.contractVersion,
    propertyId: result.propertyId,
    product: result.product,
    status: result.status,
    sourceManifest: result.sourceManifest,
    groups: result.groups,
    evaluatedAt: result.evaluatedAt,
  });
  if (
    verified.sourceManifestHash !== result.sourceManifestHash ||
    verified.readinessHash !== result.readinessHash
  ) {
    throw new Error("Publication lifecycle evidence hashes do not match its readiness snapshot");
  }

  return deepFreezeLifecycleSnapshot({
    contractVersion: verified.contractVersion,
    propertyId: verified.propertyId,
    product: expected.product,
    status: "ready" as const,
    sourceManifest: verified.sourceManifest,
    sourceManifestHash: verified.sourceManifestHash,
    readinessHash: verified.readinessHash,
  }) as ReadyProductReadinessEvidence<TProduct>;
}

type ImmutableRevision<TProduct extends ReadinessProduct> = Readonly<{
  propertyId: string;
  revisionNumber: number;
  readiness: ReadyProductReadinessEvidence<TProduct>;
}>;

export type BookingContentRevision = ImmutableRevision<"booking"> &
  Readonly<{
    revisionId: BookingContentRevisionId;
    publicContent: OnboardingLifecycleJsonObject;
    builtByUserId: string;
    builtAt: string;
  }>;

export type BookingActiveContentPointer = Readonly<{
  propertyId: string;
  revisionId: BookingContentRevisionId;
  activatedByUserId: string;
  activatedAt: string;
}>;

/**
 * Distribution owns immutable Booking content and its independently moved pointer.
 * A revision is unpublished until this pointer references it; publication
 * attempt/recovery state belongs to the later publication-command slice.
 * Implementations must return detached snapshots rather than mutable storage aliases.
 */
export interface BookingContentLifecyclePort {
  appendRevision(
    input: Omit<BookingContentRevision, "revisionId" | "revisionNumber">,
  ): Promise<BookingContentRevision>;
  activate(input: {
    propertyId: string;
    revisionId: BookingContentRevisionId;
    expectedActiveRevisionId: BookingContentRevisionId | null;
    activatedByUserId: string;
  }): Promise<BookingActiveContentPointer>;
  getActive(propertyId: string): Promise<BookingActiveContentPointer | null>;
}

export type LiveAriSourceRevision = string & {
  readonly [liveAriSourceRevision]: true;
};

export function createLiveAriSourceRevision(value: string): LiveAriSourceRevision {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Live ARI source revision must be a non-empty string");
  }
  return value as LiveAriSourceRevision;
}

export type LiveAriWatermark = Readonly<{
  propertyId: string;
  watermarkRevision: number;
  sourceRevision: LiveAriSourceRevision;
  materializedThrough: string | null;
  observedAt: string;
  projectedAt: string;
}>;

/** Live ARI advances independently of immutable Booking content publication. */
export interface LiveAriWatermarkPort {
  get(propertyId: string): Promise<LiveAriWatermark | null>;
  advance(input: {
    propertyId: string;
    expectedWatermarkRevision: number;
    sourceRevision: LiveAriSourceRevision;
    materializedThrough: string | null;
    observedAt: string;
    projectedAt: string;
  }): Promise<LiveAriWatermark>;
}

function deepFreezeLifecycleSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeLifecycleSnapshot(nested, seen);
  }
  Object.freeze(object);
  return value;
}
