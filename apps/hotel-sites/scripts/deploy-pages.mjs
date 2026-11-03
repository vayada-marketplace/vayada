// Publishes build/ on Cloudflare Pages (VAY-2422); the "Deploy Hotel Sites" workflow runs it after
// `npm run build:hotel-sites`. Each hotel has its own Pages project, `vayada-site-<slug>`, created
// here on its first deploy, with its address attached as a custom domain. vayada-platform's
// Terraform points that address's DNS record at `vayada-site-<slug>.pages.dev`. Then wrangler
// uploads the hotel's build/<host>/ folder as the project's production deployment.
//
// Env: CLOUDFLARE_API_TOKEN (a token with only Account › Cloudflare Pages › Edit) and
// CLOUDFLARE_ACCOUNT_ID. CLOUDFLARE_API_BASE_URL, which wrangler honours too, defaults to the API.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRANGLER = "wrangler@4.151.3";
const build = fileURLToPath(new URL("../build", import.meta.url));
const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env;
const api = process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4";
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");

for (const { slug, host } of JSON.parse(await readFile(path.join(build, "sites.json"), "utf8"))) {
  const name = `vayada-site-${slug}`;
  const project =
    (await call("GET", `/pages/projects/${name}`, { missing: null })) ??
    (await call("POST", "/pages/projects", { body: { name, production_branch: "main" } }));
  // Pages adds a suffix when the pages.dev name is taken; the DNS record names it exactly.
  if (project.subdomain !== `${name}.pages.dev`) {
    throw new Error(
      `${name} is ${project.subdomain}: point vayada-platform's ${host} record there`,
    );
  }
  const domain = (await call("GET", `/pages/projects/${name}/domains`)).find(
    (d) => d.name === host,
  );
  if (!domain) {
    await call("POST", `/pages/projects/${name}/domains`, { body: { name: host } });
  } else if (domain.status !== "active") {
    // Validation retries stop after a while; this asks Pages to check the DNS record again.
    await call("PATCH", `/pages/projects/${name}/domains/${host}`);
  }
  const args = ["--yes", WRANGLER, "pages", "deploy", path.join(build, host)];
  args.push(`--project-name=${name}`, "--branch=main", "--commit-dirty=true");
  execFileSync("npx", args, { stdio: "inherit" });
  console.log(`${host}: published to ${name} (domain ${domain?.status ?? "added"})`);
}

/** One Cloudflare API call under the account; `missing` is returned for a 404. */
async function call(method, route, { body, missing } = {}) {
  const response = await fetch(`${api}/accounts/${account}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (response.status === 404 && missing !== undefined) return missing;
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.success) {
    throw new Error(`${method} ${route}: ${response.status} ${JSON.stringify(json.errors ?? [])}`);
  }
  return json.result;
}
