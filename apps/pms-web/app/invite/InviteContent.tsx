"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import InviteJoinForm, {
  INVITE_PASSWORD_MIN_LENGTH,
  inviteFailure,
  inviteSubmitProblem,
  type InviteJoinView,
} from "@/components/auth/InviteJoinForm";
import { useTranslation } from "@/lib/i18n";
import { authService } from "@/services/auth";

const TOKEN_STORAGE_KEY = "vayada_invitation_token";

// The emailed link is /invite?invitation_token=… (WorkOS "User invitation URL"; `token` is accepted
// too). Keep the token for this tab only and take it out of the address bar, so it is not shared,
// bookmarked or logged.
function takeInvitationToken(): string {
  const url = new URL(window.location.href);
  const fromLink = (
    url.searchParams.get("invitation_token") ?? url.searchParams.get("token")
  )?.trim();
  if (fromLink) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromLink);
    } catch {
      /* Without storage a reload needs the link again. */
    }
    url.searchParams.delete("invitation_token");
    url.searchParams.delete("token");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    return fromLink;
  }
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function InviteContent() {
  const { t } = useTranslation();
  const [token, setToken] = useState("");
  const [view, setView] = useState<InviteJoinView>({ kind: "loading" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const found = takeInvitationToken();
    if (!found) {
      setView({ kind: "unavailable", reason: "invalid" });
      return;
    }
    setToken(found);
    let cancelled = false;
    authService
      .previewInvitation(found)
      .then((invitation) => {
        if (cancelled) return;
        setName(invitation.inviteeName ?? "");
        setView({ kind: "ready", invitation });
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setView({
          kind: "unavailable",
          reason: inviteFailure(failure).unavailableReason ?? "error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (view.kind !== "ready" || isSubmitting) return;
      const isNew = !view.invitation.accountExists;
      const problem = inviteSubmitProblem({ isNew, name, password, confirmPassword });
      if (problem) {
        setError(t(problem, { count: INVITE_PASSWORD_MIN_LENGTH }));
        return;
      }
      setError("");
      setIsSubmitting(true);
      try {
        await authService.acceptInvitation({
          invitationToken: token,
          password,
          ...(isNew ? { name: name.trim() } : {}),
        });
        try {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        } catch {
          /* Nothing kept. */
        }
        window.location.replace("/dashboard");
      } catch (failure) {
        const outcome = inviteFailure(failure);
        if (outcome.unavailableReason) {
          setView({ kind: "unavailable", reason: outcome.unavailableReason });
        } else {
          setError(t(outcome.messageKey, { count: INVITE_PASSWORD_MIN_LENGTH }));
        }
        setIsSubmitting(false);
      }
    },
    [confirmPassword, isSubmitting, name, password, t, token, view],
  );

  return (
    <InviteJoinForm
      view={view}
      name={name}
      password={password}
      confirmPassword={confirmPassword}
      isSubmitting={isSubmitting}
      error={error}
      onNameChange={setName}
      onPasswordChange={setPassword}
      onConfirmPasswordChange={setConfirmPassword}
      onSubmit={handleSubmit}
    />
  );
}
