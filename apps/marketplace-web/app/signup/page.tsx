import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { firstSearchParam, safeRelativeReturnTo } from "@vayada/hotel-setup-wizard/returnTo";

const AUTH_API_BASE_URL =
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "https://api.localhost";

type SignupIntent = "creator" | "hotel";

type SignUpPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = (await searchParams) ?? {};
  const intent = signupIntent(firstSearchParam(params.type));
  const returnTo = safeRelativeReturnTo(params.returnTo, "/marketplace");
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "https://app.vayada.com";

  const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/signup`);
  url.searchParams.set("surface", "marketplace-web");
  url.searchParams.set("intent", intent);

  const callbackUrl = new URL("/login?auth=callback", origin);
  callbackUrl.searchParams.set("returnTo", returnTo);
  url.searchParams.set("return_to", callbackUrl.toString());

  const loginHint = firstSearchParam(params.login_hint);
  if (loginHint) url.searchParams.set("login_hint", loginHint);

  redirect(url.toString());
}

function signupIntent(value: string | undefined): SignupIntent {
  return value === "hotel" ? "hotel" : "creator";
}
