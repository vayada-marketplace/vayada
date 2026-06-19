export function normalizePgConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      return connectionString;
    }

    if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
    }

    return url.toString();
  } catch {
    return connectionString;
  }
}
