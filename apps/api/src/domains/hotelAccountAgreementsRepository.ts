import type {
  HotelAccountAgreementAcceptance,
  HotelAccountAgreementSource,
  HotelAccountAgreementVersions,
} from "@vayada/domain-hotels";
import type { QueryResult, QueryResultRow } from "pg";

type Pool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
};

export type HotelAccountAgreementsRepository = {
  /** The hotel account's acceptance of exactly these versions, or null. */
  findAcceptance(
    organizationId: string,
    versions: HotelAccountAgreementVersions,
  ): Promise<HotelAccountAgreementAcceptance | null>;
  /**
   * The account admin accepts these versions for the hotel account: at sign-up or later. The first
   * acceptance of a pair of versions stays. Null when the person isn't the active account admin of an
   * active hotel account.
   */
  accept(input: {
    organizationId: string;
    userId: string;
    source: HotelAccountAgreementSource;
    versions: HotelAccountAgreementVersions;
  }): Promise<HotelAccountAgreementAcceptance | null>;
};

type AcceptanceRow = {
  termsVersion: string;
  dpaVersion: string;
  acceptedAt: Date;
  source: HotelAccountAgreementSource;
  name: string | null;
  email: string;
};

const ACCEPTANCE_SQL = `
SELECT acceptance.terms_version AS "termsVersion", acceptance.dpa_version AS "dpaVersion",
       acceptance.accepted_at AS "acceptedAt", acceptance.source, person.name, person.email
FROM hotel_catalog.account_agreement_acceptances acceptance
JOIN identity.users person ON person.id = acceptance.accepted_by_user_id
WHERE acceptance.organization_id = $1::uuid
  AND acceptance.terms_version = $2 AND acceptance.dpa_version = $3`;

/** VAY-2246 (migration 0511). The account admin is the active hotel_owner member: only the
 * account_admin role definition has that base role (0202). */
const ACCEPT_SQL = `
WITH admin AS (
  SELECT membership.user_id
  FROM identity.organization_memberships membership
  JOIN identity.organizations organization
    ON organization.id = membership.organization_id
   AND organization.kind = 'hotel_group' AND organization.status = 'active'
  JOIN identity.users person ON person.id = membership.user_id AND person.status = 'active'
  WHERE membership.organization_id = $1::uuid AND membership.user_id = $2::uuid
    AND membership.status = 'active' AND membership.role_key = 'hotel_owner'
  FOR SHARE OF membership, organization, person
), recorded AS (
  INSERT INTO hotel_catalog.account_agreement_acceptances
    (organization_id, terms_version, dpa_version, accepted_by_user_id, source)
  SELECT $1::uuid, $3, $4, admin.user_id, $5 FROM admin
  ON CONFLICT (organization_id, terms_version, dpa_version) DO NOTHING
  RETURNING id
)
SELECT EXISTS (SELECT 1 FROM admin) AS "isAccountAdmin"`;

function acceptance(row: AcceptanceRow | undefined): HotelAccountAgreementAcceptance | null {
  if (!row) return null;
  return {
    termsVersion: row.termsVersion,
    dpaVersion: row.dpaVersion,
    acceptedAt: row.acceptedAt.toISOString(),
    acceptedBy: { name: row.name, email: row.email },
    source: row.source,
  };
}

export function createPgHotelAccountAgreementsRepository(
  pool: Pool,
): HotelAccountAgreementsRepository {
  async function findAcceptance(organizationId: string, versions: HotelAccountAgreementVersions) {
    const result = await pool.query<AcceptanceRow>(ACCEPTANCE_SQL, [
      organizationId,
      versions.termsVersion,
      versions.dpaVersion,
    ]);
    return acceptance(result.rows[0]);
  }
  return {
    findAcceptance,
    async accept({ organizationId, userId, source, versions }) {
      const result = await pool.query<{ isAccountAdmin: boolean }>(ACCEPT_SQL, [
        organizationId,
        userId,
        versions.termsVersion,
        versions.dpaVersion,
        source,
      ]);
      if (result.rows[0]?.isAccountAdmin !== true) return null;
      return findAcceptance(organizationId, versions);
    },
  };
}
