import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { firstSearchParam, safeRelativeReturnTo } from "@vayada/hotel-setup-wizard/returnTo";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

type RegisterPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo = safeRelativeReturnTo(params.returnTo, "/dashboard");
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "https://pms.vayada.com";

  const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/signup`);
  url.searchParams.set("surface", "pms-web");
  url.searchParams.set("intent", "hotel");

  const callbackUrl = new URL("/login?auth=callback", origin);
  callbackUrl.searchParams.set("returnTo", returnTo);
  url.searchParams.set("return_to", callbackUrl.toString());

  const loginHint = firstSearchParam(params.login_hint);
  if (loginHint) url.searchParams.set("login_hint", loginHint);

  redirect(url.toString());
}
