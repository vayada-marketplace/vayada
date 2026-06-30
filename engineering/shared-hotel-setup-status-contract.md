# Shared Hotel Setup Status Contract

_VAY-966 contract record. Parent: VAY-965._

## Purpose

Vayada hotel users should complete shared property facts once, then activate
Booking Engine, PMS, and Creator Marketplace independently per property. This
contract defines the shared setup status response that those product apps use
after login.

The contract deliberately models the new canonical setup world. It does not use
legacy Booking/PMS/Marketplace product links as the normal authorization or
routing source.

## Decision

Shared setup is property-centered.

```text
hotel_group organization
-> direct identity.organization_resource_links row
   product = 'hotel_catalog'
   resource_type = 'property'
   resource_id = hotel_catalog.properties.id
-> shared setup status for that canonical property
```

Product-native records remain product-specific:

```text
Booking hotel / PMS property / Marketplace hotel profile
-> hotel_catalog.property_source_links
-> hotel_catalog.properties.id
```

`property_source_links` is provenance and product-record mapping. It is not the
authorization model for shared setup.

## Implementation Prerequisites

Before VAY-967 implements this API, identity must support the canonical hotel
catalog resource scope:

- Add `hotel_catalog` to the identity product enum used by
  `identity.organization_resource_links`, `identity.product_entitlements`, and
  `@vayada/backend-auth` `Product`.
- Ensure `property` is accepted as a resource type in identity DDL and
  `@vayada/backend-auth` `ResourceType`.
- Add `hotel_catalog.setup.read` to `@vayada/backend-auth` `PermissionKey` and
  seed `identity.permission_catalog`.
- Seed role grants for hotel-group roles that may read setup status.
- Backfill direct active property resource links for every hotel-group property
  that should appear in shared setup.

No VAY-967 route should fall back to `property_source_links` to infer ownership.
If direct property links are missing, the property is not in the status
response.

## Endpoint

```http
GET /api/hotel-setup/status?entryProduct=booking&returnTo=/dashboard&propertyId=<uuid>
```

The final route adapter may choose a different prefix, but it must preserve the
response contract below.

### Query

| Field          | Type                                | Required | Notes                                                                |
| -------------- | ----------------------------------- | -------- | -------------------------------------------------------------------- |
| `entryProduct` | `booking` \| `pms` \| `marketplace` | no       | Product surface the user entered from. Defaults to server inference. |
| `returnTo`     | string                              | no       | Server validates and returns only a safe same-origin or allowed URL. |
| `propertyId`   | UUID                                | no       | Requested canonical property. Must be directly linked to the org.    |

Invalid `returnTo` values are ignored and returned as `null`. Invalid or
unauthorized `propertyId` values return a `403` or `404` from the route adapter;
they must not silently select a different property.

## Authorization

The route is available only to authenticated users in an active
`hotel_group` organization.

Route policy:

```ts
{
  permission: "hotel_catalog.setup.read";
}
```

Returned properties are further filtered to active direct property links:

```ts
{
  product: "hotel_catalog",
  resourceType: "property",
  resourceId: property.propertyId,
  allowedRelationships: ["owner", "operator"]
}
```

Product activation details may be derived from product tables, entitlements, or
activation tables, but only after the canonical property itself is authorized.

## Response

```ts
type SharedHotelSetupStatus = {
  contractVersion: "shared-hotel-setup-status.v1";
  entry: {
    entryProduct: "booking" | "pms" | "marketplace" | null;
    returnTo: string | null;
  };
  hotelGroup: {
    organizationId: string;
    displayName: string;
  };
  selection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
  };
  properties: SharedSetupProperty[];
  nextAction: SharedSetupNextAction;
  updatedAt: string;
};

type SharedSetupProperty = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  sharedProfile: {
    status: "incomplete" | "complete" | "disabled" | "private";
    completionPercent: number;
    missingFields: SharedPropertyProfileMissingField[];
  };
  products: {
    booking: SharedProductActivation<"booking">;
    pms: SharedProductActivation<"pms">;
    marketplace: SharedProductActivation<"marketplace">;
  };
};

type SharedPropertyProfileMissingField =
  | "displayName"
  | "location"
  | "website"
  | "phone"
  | "description"
  | "media";

type SharedProductActivation<Product extends "booking" | "pms" | "marketplace"> = {
  product: Product;
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable";
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

type SharedSetupNextAction =
  | { action: "create_property"; reasonCodes: string[] }
  | { action: "select_property"; reasonCodes: string[] }
  | {
      action: "complete_shared_profile";
      propertyId: string;
      missingFields: SharedPropertyProfileMissingField[];
      reasonCodes: string[];
    }
  | { action: "select_products"; propertyId: string; reasonCodes: string[] }
  | {
      action: "complete_product_activation";
      propertyId: string;
      product: "booking" | "pms" | "marketplace";
      missingSteps: string[];
      reasonCodes: string[];
    }
  | {
      action: "enter_product";
      propertyId: string;
      product: "booking" | "pms" | "marketplace";
      returnTo: string | null;
      reasonCodes: string[];
    };
```

## State Rules

- `selection.state = "no_property"` means the hotel group has no active direct
  canonical property links.
- `selection.state = "single_property"` means exactly one directly linked
  property exists; clients may auto-select it.
- `selection.state = "multiple_properties"` means the client must let the user
  choose a property unless `selectedPropertyId` is already set.
- `sharedProfile.status` mirrors the canonical catalog profile status from
  `hotel_catalog.properties` or
  `hotel_catalog.property_public_profile_read_model`: `complete`, `incomplete`,
  `disabled`, or `private`.
- `products.<product>.status` is based only on that product's selection and
  activation state for the selected canonical property.
- `disabled` and `private` are shared catalog states; they must not be collapsed
  into product `suspended` or `unavailable` states.
- `not_selected` means the hotel has not chosen that product for the property.
- `selected_incomplete` means the product was chosen but product-specific setup
  is missing.
- `active` means the product can be entered normally for that property.
- `suspended` means the product exists but is blocked by product or billing
  state.
- `unavailable` means the product cannot currently be used for that property or
  organization.

`sharedProfile.status` and `products.<product>.status` must never be collapsed
into one generic `profileComplete` boolean.

## Product Activation Boundaries

Shared profile fields:

- display name
- location
- public website/contact phone
- short or long description
- media/cover/gallery readiness

Product-specific activation examples:

- Booking Engine: rooms, rates, policies, payment readiness, public booking
  capability.
- PMS: operational room/inventory setup, channel connections, PMS modules.
- Creator Marketplace: creator-facing pitch, collaboration offers, creator
  requirements, listing setup.

Marketplace must not ask for shared hotel basics when `sharedProfile.status` is
`complete`; it should show "Activate Creator Marketplace" style copy and only
ask for Marketplace activation inputs.

## Examples

### No Property

```json
{
  "contractVersion": "shared-hotel-setup-status.v1",
  "entry": { "entryProduct": "booking", "returnTo": "/dashboard" },
  "hotelGroup": {
    "organizationId": "11111111-1111-1111-1111-111111111111",
    "displayName": "Bali Hospitality Group"
  },
  "selection": { "state": "no_property", "selectedPropertyId": null },
  "properties": [],
  "nextAction": {
    "action": "create_property",
    "reasonCodes": ["no_property"]
  },
  "updatedAt": "2026-06-30T08:00:00.000Z"
}
```

### Shared Profile Complete, Marketplace Incomplete

```json
{
  "contractVersion": "shared-hotel-setup-status.v1",
  "entry": { "entryProduct": "marketplace", "returnTo": "/marketplace" },
  "hotelGroup": {
    "organizationId": "11111111-1111-1111-1111-111111111111",
    "displayName": "Bali Hospitality Group"
  },
  "selection": {
    "state": "single_property",
    "selectedPropertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  },
  "properties": [
    {
      "propertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "publicId": "alpenrose-resort",
      "displayName": "Alpenrose Resort",
      "locationSummary": "Bali, Indonesia",
      "sharedProfile": {
        "status": "complete",
        "completionPercent": 100,
        "missingFields": []
      },
      "products": {
        "booking": {
          "product": "booking",
          "status": "active",
          "missingSteps": [],
          "statusReasons": [],
          "updatedAt": "2026-06-30T08:00:00.000Z"
        },
        "pms": {
          "product": "pms",
          "status": "not_selected",
          "missingSteps": [],
          "statusReasons": [],
          "updatedAt": null
        },
        "marketplace": {
          "product": "marketplace",
          "status": "selected_incomplete",
          "missingSteps": ["creatorPitch", "collaborationOffer", "creatorRequirements"],
          "statusReasons": ["marketplace_activation_incomplete"],
          "updatedAt": "2026-06-30T08:00:00.000Z"
        }
      }
    }
  ],
  "nextAction": {
    "action": "complete_product_activation",
    "propertyId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "product": "marketplace",
    "missingSteps": ["creatorPitch", "collaborationOffer", "creatorRequirements"],
    "reasonCodes": ["entry_product_activation_incomplete"]
  },
  "updatedAt": "2026-06-30T08:00:00.000Z"
}
```

## Follow-Up Contracts

- VAY-975 adds canonical `hotel_catalog/property` identity links required by
  this contract.
- VAY-967 implements the read endpoint against this contract.
- VAY-968 defines per-property product selection storage.
- VAY-969 defines shared property profile create/update commands.
- VAY-970 consumes this contract in the shared setup wizard.
- VAY-971 applies this contract to Booking Admin, PMS, and Marketplace guards.
- VAY-972 replaces Marketplace generic profile completion with Marketplace
  activation state.

## Cleanup Position

Legacy product profile/status routes may remain temporarily for old surfaces,
but new shared setup code must not call them for routing. Cleanup should remove
runtime dependencies once `rg` proves no route, client, parity fixture, or
rollback path still needs the compatibility behavior.
