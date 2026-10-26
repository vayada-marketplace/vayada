"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { EyeIcon, EyeSlashIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { AuthStateError, type InvitationPreview } from "@/services/auth";

// The PMS team invitation page (VAY-2274), drawn after the approved Paper boards "VAY-2274 Join
// invite": the PMS login card with a create-account and a log-in state.

export const INVITE_PASSWORD_MIN_LENGTH = 10;

export type InviteJoinView =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; invitation: InvitationPreview };

export type InviteJoinFormProps = {
  view: InviteJoinView;
  name: string;
  password: string;
  confirmPassword: string;
  isSubmitting: boolean;
  error: string;
  onNameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const MARKETING_BASE_URL = process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com";

const ROLE_LABEL_KEYS: Record<string, string> = {
  hotel_manager: "settings.team.roleManager",
  front_desk: "settings.team.roleFrontDesk",
  housekeeping: "settings.team.roleHousekeeping",
  external_owner: "settings.team.roleOwner",
};

/** The message key for a form that must not be sent yet, or null. */
export function inviteSubmitProblem(input: {
  isNew: boolean;
  name: string;
  password: string;
  confirmPassword: string;
}): string | null {
  if (!input.isNew) return input.password ? null : "auth.invite.passwordRequired";
  if (!input.name.trim()) return "auth.invite.nameRequired";
  if (input.password.length < INVITE_PASSWORD_MIN_LENGTH) return "auth.invite.passwordTooShort";
  if (input.password !== input.confirmPassword) return "auth.invite.passwordsDontMatch";
  return null;
}

/** What a failed preview or accept means for the page: a dead link, or a message on the form. */
export function inviteFailure(error: unknown): { unavailableReason?: string; messageKey: string } {
  if (!(error instanceof AuthStateError)) return { messageKey: "auth.login.unexpectedError" };
  if (error.state === "invitation_unavailable") {
    return { unavailableReason: error.reason || "invalid", messageKey: "" };
  }
  if (error.state === "invalid_credentials") return { messageKey: "auth.invite.wrongPassword" };
  if (error.state === "email_verification_required") {
    return { messageKey: "auth.invite.verifyEmailFirst" };
  }
  const byCode: Record<string, string> = {
    password_too_weak: "auth.invite.passwordTooWeak",
    name_required: "auth.invite.nameRequired",
    invitation_not_joined: "auth.invite.notJoined",
  };
  return { messageKey: (error.code && byCode[error.code]) || "auth.login.unexpectedError" };
}

/** "Hotel A", "Hotel A and Hotel B", … in the reader's language. */
export function formatHotelNames(names: string[], locale: string): string {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(cleaned);
  } catch {
    return cleaned.join(", ");
  }
}

export default function InviteJoinForm(props: InviteJoinFormProps) {
  const { t, locale } = useTranslation();
  const { view } = props;

  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="flex min-h-screen w-full flex-col px-4 lg:w-[40%]">
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={120}
              height={40}
              className="mx-auto mb-4 h-10 w-auto"
            />
            {view.kind === "loading" && (
              <p role="status" className="text-center text-sm text-gray-500">
                {t("auth.invite.loading")}
              </p>
            )}
            {view.kind === "unavailable" && <UnavailableInvitation reason={view.reason} />}
            {view.kind === "ready" && (
              <ReadyInvitation {...props} invitation={view.invitation} locale={locale} />
            )}
          </div>
        </div>
        {view.kind === "ready" && (
          <p className="pb-8 text-center text-xs leading-5 text-gray-500">
            {t("auth.invite.legalPrefix")}{" "}
            <a
              href={`${MARKETING_BASE_URL}/terms`}
              className="font-medium text-primary-600 hover:text-primary-700"
            >
              {t("auth.invite.terms")}
            </a>{" "}
            {t("auth.invite.legalConnector")}{" "}
            <a
              href={`${MARKETING_BASE_URL}/privacy`}
              className="font-medium text-primary-600 hover:text-primary-700"
            >
              {t("auth.invite.privacy")}
            </a>
            {t("auth.invite.legalSuffix")}
          </p>
        )}
      </div>
      <div
        className="relative hidden min-h-screen flex-1 overflow-hidden bg-cover bg-center lg:block"
        style={{ backgroundImage: "url('/hotel-hero.JPG')" }}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-gray-950/20" />
      </div>
    </div>
  );
}

// "error" is a temporary failure (the link may still work); the other reasons are final.
function UnavailableInvitation({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const copy =
    reason === "accepted"
      ? { title: "auth.invite.acceptedTitle", body: ["auth.invite.acceptedBody"] }
      : reason === "error"
        ? { title: "auth.invite.errorTitle", body: ["auth.invite.errorBody"] }
        : {
            title: "auth.invite.unavailableTitle",
            body: ["auth.invite.unavailableBody", "auth.invite.askAgain"],
          };
  return (
    <div className="text-center">
      <h1 className="text-xl font-bold text-gray-900">{t(copy.title)}</h1>
      {copy.body.map((key, index) => (
        <p key={key} className={`${index ? "mt-1" : "mt-2"} text-[13px] text-gray-500`}>
          {t(key)}
        </p>
      ))}
      <a
        href={reason === "error" ? "/invite" : "/login"}
        className="mt-6 block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50"
      >
        {reason === "error" ? t("auth.invite.tryAgain") : t("auth.invite.goToLogin")}
      </a>
    </div>
  );
}

function ReadyInvitation({
  invitation,
  locale,
  name,
  password,
  confirmPassword,
  isSubmitting,
  error,
  onNameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
}: InviteJoinFormProps & { invitation: InvitationPreview; locale: string }) {
  const { t } = useTranslation();
  const hotel = formatHotelNames(invitation.hotelNames, locale) || t("auth.invite.fallbackHotel");
  const roleKey = ROLE_LABEL_KEYS[invitation.roleKey];
  const role = invitation.roleName?.trim() || (roleKey ? t(roleKey) : "");
  const isNew = !invitation.accountExists;
  const inviter = invitation.inviterName;

  return (
    <>
      <div className="mb-6 text-center">
        <h1 className="text-xl font-bold text-gray-900">{t("auth.invite.title", { hotel })}</h1>
        <p className="mt-1 text-[13px] text-gray-500">
          {role
            ? t("auth.invite.subtitleWithRole", { inviter, hotel, role })
            : t("auth.invite.subtitle", { inviter, hotel })}
        </p>
      </div>
      {/* POST: a click before the page hydrates must not put the password in the URL. */}
      <form method="post" onSubmit={onSubmit} className="space-y-5">
        {!isNew && (
          <p className="rounded-lg border border-primary-100 bg-primary-50 px-4 py-3 text-sm text-gray-900">
            {t("auth.invite.accountExists")}
          </p>
        )}
        <div>
          <label htmlFor="invite-email" className="mb-1.5 block text-sm font-medium text-gray-700">
            {t("auth.login.emailLabel")}
          </label>
          <div className="relative">
            <input
              id="invite-email"
              type="email"
              value={invitation.email}
              readOnly
              aria-readonly="true"
              autoComplete="username"
              className="w-full cursor-default rounded-lg border border-gray-200 bg-gray-100 px-4 py-2.5 pr-11 text-sm text-gray-500 focus:outline-none"
            />
            <LockClosedIcon
              className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              aria-hidden="true"
            />
          </div>
        </div>
        {isNew && (
          <div>
            <label htmlFor="invite-name" className="mb-1.5 block text-sm font-medium text-gray-700">
              {t("auth.invite.nameLabel")}
            </label>
            <input
              id="invite-name"
              name="name"
              type="text"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              required
              maxLength={200}
              autoComplete="name"
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        )}
        <PasswordField
          id="invite-password"
          label={t("auth.login.passwordLabel")}
          value={password}
          onChange={onPasswordChange}
          autoComplete={isNew ? "new-password" : "current-password"}
          hint={isNew ? t("auth.invite.passwordHint", { count: INVITE_PASSWORD_MIN_LENGTH }) : ""}
          forgotPassword={!isNew}
        />
        {isNew && (
          <PasswordField
            id="invite-confirm-password"
            label={t("auth.invite.confirmPasswordLabel")}
            value={confirmPassword}
            onChange={onConfirmPasswordChange}
            autoComplete="new-password"
            hint=""
            forgotPassword={false}
          />
        )}
        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting
            ? t("auth.invite.submitting")
            : isNew
              ? t("auth.invite.createAndJoin")
              : t("auth.invite.logInAndJoin")}
        </button>
        <p className="text-center text-sm text-gray-600">
          {t("auth.invite.wrongAddress", { inviter })}
        </p>
      </form>
    </>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  forgotPassword,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint: string;
  forgotPassword: boolean;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          autoComplete={autoComplete}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 pr-12 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          aria-label={visible ? t("auth.invite.hidePassword") : t("auth.invite.showPassword")}
        >
          {visible ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
        </button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-gray-500">
          {hint}
        </p>
      )}
      {forgotPassword && (
        <div className="mt-2 text-right">
          <a
            href="/forgot-password"
            className="text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            {t("auth.login.forgotPassword")}
          </a>
        </div>
      )}
    </div>
  );
}
