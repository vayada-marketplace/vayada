import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginContent } from "./LoginContent";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  if (params.auth === "callback") {
    return <LoginContent />;
  }

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : "https://pms.vayada.com";
  const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
  url.searchParams.set("surface", "pms-web");
  url.searchParams.set("return_to", `${origin}/login?auth=callback`);
  redirect(url.toString());
}
