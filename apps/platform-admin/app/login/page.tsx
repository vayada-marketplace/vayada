"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { authService } from "@/services/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await authService.login(email, password);
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen dashboard-grid bg-bone px-4 py-10 text-ink">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md items-center">
        <form
          onSubmit={handleSubmit}
          className="w-full rounded-lg border border-ink/10 bg-white p-7 shadow-panel"
        >
          <div className="mb-7">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-ink text-bone">
              <LockClosedIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
              vayada platform
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal">Admin sign in</h1>
            <p className="mt-2 text-sm text-ink/60">Super-admin access only.</p>
          </div>

          <label className="block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 h-11 w-full rounded-md border border-ink/15 bg-bone/60 px-3 outline-none ring-lagoon/25 transition focus:border-lagoon focus:ring-4"
            autoComplete="email"
            required
          />

          <label className="mt-5 block text-sm font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 h-11 w-full rounded-md border border-ink/15 bg-bone/60 px-3 outline-none ring-lagoon/25 transition focus:border-lagoon focus:ring-4"
            autoComplete="current-password"
            required
          />

          {error ? (
            <div className="mt-5 rounded-md border border-ember/25 bg-ember/10 px-3 py-2 text-sm text-ember">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-bone transition hover:bg-lagoon disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Signing in" : "Continue"}
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
      </div>
    </main>
  );
}
