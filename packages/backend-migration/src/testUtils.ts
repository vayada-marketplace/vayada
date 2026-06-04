/** Throws if the given Postgres URL does not target a database with "test" in its name. */
export function assertSafeTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(dbName)) {
    throw new Error(
      `Refusing to run destructive test cleanup against non-test database "${dbName}". ` +
        `TEST_DATABASE_URL must point to a database with "test" in its name.`,
    );
  }
}
