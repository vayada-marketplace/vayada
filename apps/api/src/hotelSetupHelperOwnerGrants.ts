import { createHash } from "node:crypto";
import pg from "pg";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";

const helpers = new Map([
  [
    "platform.channex_management_worker_scope(text,text,uuid)",
    [
      "3962821606acc183a80d7cdeba3e264c6e957b97de8ac021c32b84ad1a7ea13c",
      "2876336c9cdddbc60acc10f74c7cb9f9a575fb035824f55b961390215281cbb2",
    ],
  ],
  [
    "platform.channex_management_worker_source(text,text,uuid)",
    [
      "81ad6522ed4c24661b0fd47dcc301799adc25b833c5aa313a506ade413ee5dd7",
      "8333d3b5cfe357880922d0dc0b46360d419f06194ecd449371bd115bcef73b76",
    ],
  ],
]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Edge = { grantor: number; grantee: number; privilege_type: string; is_grantable: boolean };
type Helper = {
  oid: number;
  signature: string;
  proowner: number;
  prosrc: string;
  definition: string;
  metadata: unknown;
  acl: Edge[];
};
type Phase = "owner_preflight" | "grant_attempted" | "grant_confirmed";
type Catalog = "unchanged" | "exact_granted" | "unexpected" | "unavailable";

/** Contains only nonsecret recovery coordinates. Never carries a pg/AWS error. */
export class HotelSetupHelperGrantInspection extends Error {
  constructor(
    readonly receipt: {
      phase: Phase;
      login: string;
      roleOid: number;
      catalog: Catalog;
      commitAttempted: boolean;
      committed?: boolean;
    },
  ) {
    super("Hotel setup helper grant requires recovery inspection");
  }
}

/** The coordinator holds this session lock; another connection must not reacquire it. */
export async function assertHotelSetupBootstrapLock(holder: pg.Client) {
  const result = await holder.query<{ held: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
      AND pid=pg_catalog.pg_backend_pid() AND classid=0 AND objid=8734516
      AND objsubid=1 AND granted AND mode IN ('ShareLock','ExclusiveLock')) AS held`);
  if (result.rows[0]?.held !== true) throw new Error("Hotel setup bootstrap lock unavailable");
}

/** Only fresh disabled operational roles, never an existing login or arbitrary function. */
export async function grantFreshHotelSetupHelpers(input: {
  ownerDatabaseUrl: string;
  databaseEndpoint: string;
  holder: pg.Client;
  login: string;
  roleOid: number;
  kind: "organization" | "property";
  signatures: readonly string[];
  onPhase?: (receipt: {
    phase: Phase;
    login: string;
    roleOid: number;
    commitAttempted: boolean;
    committed?: boolean;
  }) => void;
}) {
  if (input.kind !== "organization" && input.kind !== "property") throw new Error();
  if (!input.signatures.length) return;
  const pattern =
    input.kind === "organization"
      ? /^vayada_next_hotel_setup_org_[a-f0-9]{16}_[a-f0-9]{12}$/
      : /^vayada_next_hotel_setup_property_[a-f0-9]{16}_[a-f0-9]{12}$/;
  if (
    !pattern.test(input.login) ||
    !Number.isInteger(input.roleOid) ||
    input.roleOid <= 0 ||
    input.roleOid > 4294967295 ||
    input.signatures.length > 2 ||
    new Set(input.signatures).size !== input.signatures.length ||
    input.signatures.some((signature) => !helpers.has(signature))
  )
    throw new Error();
  const url = parseHotelSetupDatabaseUrl(
    input.ownerDatabaseUrl,
    input.databaseEndpoint,
    "vayada_target_prod_user",
  );
  const connection = () =>
    new pg.Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: { rejectUnauthorized: true },
      options: "-c search_path=pg_catalog",
      connectionTimeoutMillis: 10_000,
      query_timeout: 15_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
    });
  const creator = (
    await input.holder.query<{ oid: number; superuser: boolean }>(
      "SELECT r.oid,r.rolsuper AS superuser FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND current_user=session_user",
    )
  ).rows[0];
  if (!creator) throw new Error();
  const owner = connection();
  let failed = false,
    phase: Phase = "owner_preflight",
    attempted = false;
  let before: Awaited<ReturnType<typeof capture>> | undefined;
  owner.on("error", () => {
    failed = true;
  });
  owner.on("notice", (notice) => {
    if (notice.code === "01007") failed = true;
  });
  const coordinates = () => ({
    phase,
    login: input.login,
    roleOid: input.roleOid,
    commitAttempted: attempted,
    ...(phase === "grant_confirmed" ? { committed: true } : !attempted ? { committed: false } : {}),
  });
  const report = () => input.onPhase?.(coordinates());
  async function capture(client = owner, healthy = () => !failed) {
    const identity = (
      await client.query<{ principal: string; session: string; oid: number }>(
        `SELECT current_user AS principal,session_user AS session,current_user::regrole::oid AS oid`,
      )
    ).rows[0];
    if (
      identity?.principal !== "vayada_target_prod_user" ||
      identity.session !== identity.principal
    )
      throw new Error();
    const role = (
      await client.query<{ role: Record<string, unknown> }>(
        "SELECT to_jsonb(r) AS role FROM pg_catalog.pg_roles r WHERE oid=$1 AND rolname=$2",
        [input.roleOid, input.login],
      )
    ).rows[0]?.role;
    if (
      !role ||
      role.rolcanlogin !== false ||
      role.rolinherit !== false ||
      role.rolsuper !== false ||
      role.rolcreaterole !== false ||
      role.rolcreatedb !== false ||
      role.rolreplication !== false ||
      role.rolbypassrls !== false ||
      role.rolvaliduntil !== null ||
      role.rolconfig !== null
    )
      throw new Error();
    const assigned = (
      await client.query<{ present: boolean }>(
        `SELECT EXISTS (
      SELECT 1 FROM platform.hotel_setup_creation_scopes
        WHERE database_login=$1 OR credential_role_oid=$2
      UNION ALL SELECT 1 FROM platform.hotel_setup_property_scopes
        WHERE database_login=$1 OR credential_role_oid=$2) AS present`,
        [input.login, input.roleOid],
      )
    ).rows[0]?.present;
    if (assigned !== false) throw new Error();
    const membership = (
      await client.query<Record<string, unknown>>(
        `SELECT m.*,r.rolname AS parent,g.rolsuper AS grantor_superuser
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
      JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
      WHERE m.member=$1 OR m.roleid=$1 ORDER BY roleid,member,grantor`,
        [input.roleOid],
      )
    ).rows;
    const parents = membership.filter((row) => row.member === input.roleOid);
    const incoming = membership.filter((row) => row.roleid === input.roleOid);
    // PostgreSQL gives a nonsuperuser role creator one ADMIN-only edge. Nothing
    // else may inherit or SET ROLE into the disabled identity before activation.
    if (
      incoming.length !== (creator.superuser ? 0 : 1) ||
      incoming.some(
        (row) =>
          row.member !== creator.oid ||
          row.admin_option !== true ||
          row.inherit_option !== false ||
          row.set_option !== false ||
          row.grantor_superuser !== true,
      )
    )
      throw new Error();
    const scopeRole =
      input.kind === "organization"
        ? "vayada_next_hotel_setup_scope"
        : "vayada_next_hotel_setup_property_scope";
    if (
      parents.length !== 1 ||
      parents[0]?.parent !== scopeRole ||
      parents[0].inherit_option !== true ||
      parents[0].set_option !== false ||
      parents[0].admin_option !== false
    )
      throw new Error();
    const functions = (
      await client.query<Helper>(
        `SELECT p.oid,p.oid::regprocedure::text AS signature,
      p.proowner,p.prosrc,pg_catalog.pg_get_functiondef(p.oid) AS definition,
      to_jsonb(p)-'prosrc'-'proacl' AS metadata FROM pg_catalog.pg_proc p
      WHERE oid=ANY($1::regprocedure[]) ORDER BY oid`,
        [input.signatures],
      )
    ).rows;
    if (functions.length !== input.signatures.length) throw new Error();
    for (const fn of functions) {
      const expected = helpers.get(fn.signature);
      if (
        !expected ||
        fn.proowner !== identity.oid ||
        hash(fn.prosrc) !== expected[0] ||
        hash(fn.definition) !== expected[1]
      )
        throw new Error();
      fn.acl = (
        await client.query<Edge>(
          `SELECT grantor,grantee,privilege_type,is_grantable
        FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE p.oid=$1 ORDER BY grantor,grantee,privilege_type,is_grantable`,
          [fn.oid],
        )
      ).rows;
      if (
        fn.acl.some(
          (edge) => edge.grantee === 0 || (edge.grantee === input.roleOid && edge.is_grantable),
        )
      )
        throw new Error();
    }
    if (!healthy()) throw new Error();
    return { identity, role, membership, functions };
  }
  function expectedAfter(baseline: NonNullable<typeof before>, actual: NonNullable<typeof before>) {
    if (
      !same(baseline.identity, actual.identity) ||
      !same(baseline.role, actual.role) ||
      !same(baseline.membership, actual.membership)
    )
      return false;
    return baseline.functions.every((fn, index) => {
      const current = actual.functions[index];
      if (!current || !same({ ...fn, acl: undefined }, { ...current, acl: undefined }))
        return false;
      const added = {
        grantor: baseline.identity.oid,
        grantee: input.roleOid,
        privilege_type: "EXECUTE",
        is_grantable: false,
      };
      return (
        current.acl.length === fn.acl.length + 1 &&
        fn.acl.every((edge) => current.acl.some((candidate) => same(edge, candidate))) &&
        current.acl.some((edge) => same(edge, added))
      );
    });
  }
  try {
    report();
    await assertHotelSetupBootstrapLock(input.holder);
    await owner.connect();
    await owner.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    before = await capture();
    if (before.functions.some((fn) => fn.acl.some((edge) => edge.grantee === input.roleOid)))
      throw new Error();
    await assertHotelSetupBootstrapLock(input.holder);
    phase = "grant_attempted";
    report();
    for (const signature of input.signatures)
      await owner.query(
        `GRANT EXECUTE ON FUNCTION ${signature} TO ${owner.escapeIdentifier(input.login)}`,
      );
    if (!expectedAfter(before, await capture())) throw new Error();
    await assertHotelSetupBootstrapLock(input.holder);
    attempted = true;
    report();
    await owner.query("COMMIT");
    phase = "grant_confirmed";
    report();
    if (!expectedAfter(before, await capture())) throw new Error();
    await assertHotelSetupBootstrapLock(input.holder);
  } catch {
    if (!attempted) await owner.query("ROLLBACK").catch(() => undefined);
    // A same-connection read could see uncommitted grants after a lost COMMIT.
    // Close it first, then observe durable catalog state on an independent reader.
    await owner.end().catch(() => undefined);
    let catalog: Catalog = "unavailable";
    if (before) {
      const observer = connection();
      let observerFailed = false;
      observer.on("error", () => {
        observerFailed = true;
      });
      try {
        await observer.connect();
        await observer.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const actual = await capture(observer, () => !observerFailed);
        catalog = same(before, actual)
          ? "unchanged"
          : expectedAfter(before, actual)
            ? "exact_granted"
            : "unexpected";
        await observer.query("ROLLBACK");
      } catch {
        catalog = "unavailable";
      } finally {
        await observer.end().catch(() => undefined);
      }
    }
    throw new HotelSetupHelperGrantInspection({ ...coordinates(), catalog });
  } finally {
    await owner.end().catch(() => undefined);
  }
}
