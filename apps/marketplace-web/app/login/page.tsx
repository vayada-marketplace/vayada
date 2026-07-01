import { redirect } from "next/navigation";
import { firstSearchParam, safeRelativeReturnTo } from "@vayada/hotel-setup-wizard/returnTo";
import { LoginContent } from "./LoginContent";

const AUTH_API_BASE_URL =
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://api.localhost";
const MARKETPLACE_BASE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo = safeRelativeReturnTo(params.returnTo, "/marketplace");
  if (firstSearchParam(params.auth) === "callback") {
    return <LoginContent returnTo={returnTo} />;
  }

  const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
  url.searchParams.set("surface", "marketplace-web");
  const callbackUrl = new URL("/login?auth=callback", MARKETPLACE_BASE_URL);
  callbackUrl.searchParams.set("returnTo", returnTo);
  url.searchParams.set("return_to", callbackUrl.toString());

  const loginHint = firstSearchParam(params.login_hint);
  if (loginHint) {
    url.searchParams.set("login_hint", loginHint);
  }

  redirect(url.toString());
}
