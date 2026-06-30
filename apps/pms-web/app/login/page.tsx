import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginContent } from "./LoginContent";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeReturnTo(value: string | string[] | undefined, fallback: string): string {
  const raw = firstParam(value);
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const returnTo = safeReturnTo(params.returnTo, "/dashboard");
  if (firstParam(params.auth) === "callback") {
    return <LoginContent returnTo={returnTo} />;
  }

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "https://pms.vayada.com";
  const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
  url.searchParams.set("surface", "pms-web");
  const callbackUrl = new URL("/login?auth=callback", origin);
  callbackUrl.searchParams.set("returnTo", returnTo);
  url.searchParams.set("return_to", callbackUrl.toString());
  redirect(url.toString());
}
