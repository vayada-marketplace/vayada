"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SavePropertySetupDraftRequest,
  PropertySetupDraftPayload,
} from "@vayada/domain-hotels";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  adaptiveStepDraftRevision,
  adaptiveStepErrorMessage,
  isAdaptiveRevisionConflict,
  withDraftReceipt,
} from "../adaptiveSetupStepState";
import { adaptiveSetupDraftClient } from "@/services/api/adaptiveSetupDraftClient";
import {
  propertySetupDraftResetApi,
  PropertySetupDraftResetError,
} from "@/services/api/propertySetupDraftResetClient";
import { createPropertySetupRouteClient } from "@/services/api/propertySetupRouteClient";
import { targetApiClient } from "@/services/api/targetClient";

type Step = "guest_experience" | "payments";
type Payload = PropertySetupDraftPayload<Step>;
const routeClient = createPropertySetupRouteClient(targetApiClient);

/** One persistence boundary for the two final-step canonical editors. */
export function useFinalStepDraft(props: AdaptiveSetupStepComponentProps, stepId: Step) {
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  }, [props]);
  const { registerBeforeLeave, registerStaleRecovery, step } = props;
  const revision = useRef(adaptiveStepDraftRevision(props.route, props.step, stepId));
  const sessionId = useRef(props.route.sessionId);
  const values = useRef<Payload>({});
  const dirtyFields = useRef(new Set<keyof Payload>());
  const dirty = useRef(false);
  const version = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const busy = useRef(false);
  const navigating = useRef(false);
  const preserve = useRef(false);
  const [data, setData] = useState<Payload>({});
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const initialize = useCallback(
    (canonical: Payload) => {
      const draft = propsRef.current.step.draft;
      const local = preserve.current
        ? values.current
        : draft?.stepId === stepId
          ? draft.payload
          : {};
      const fields = preserve.current
        ? dirtyFields.current
        : new Set(draft?.stepId === stepId ? draft.dirtyFields : []);
      const next = { ...canonical };
      for (const field of Array.from(fields))
        if (Object.hasOwn(local, field))
          Object.assign(next, { [field]: local[field as keyof typeof local] });
      // A retained checkbox cannot establish review of newly loaded source evidence.
      if (stepId === "guest_experience") next["policy.cancellation_bundle_confirmation"] = false;
      values.current = next;
      dirtyFields.current = new Set(fields as Set<keyof Payload>);
      dirty.current = preserve.current && fields.size > 0;
      preserve.current = false;
      setData(next);
    },
    [stepId],
  );
  const change = (field: keyof Payload, value: Payload[keyof Payload]) => {
    if (busy.current) return;
    values.current = { ...values.current, [field]: value };
    dirtyFields.current.add(field);
    dirty.current = true;
    version.current += 1;
    setData(values.current);
    setError(null);
  };
  const persist = useCallback(async () => {
    if (pending.current) return pending.current;
    const task = (async () => {
      while (dirty.current) {
        const captured = version.current;
        const base = revision.current;
        if (!base.baseRevisions)
          throw new Error("Current setup sources are unavailable. Refresh before saving.");
        const receipt = await adaptiveSetupDraftClient.save(propsRef.current.propertyId, {
          stepId,
          payload: values.current,
          dirtyFields: Array.from(dirtyFields.current),
          expectedTrackRevision: base.trackRevision,
          expectedSessionRevision: base.sessionRevision,
          expectedDraftRevision: base.draftRevision,
          expectedBaseRevisions: base.baseRevisions,
        } as SavePropertySetupDraftRequest);
        revision.current = withDraftReceipt(base, receipt);
        sessionId.current = receipt.sessionId;
        if (captured === version.current) dirty.current = false;
      }
    })();
    pending.current = task;
    try {
      await task;
    } finally {
      pending.current = null;
    }
  }, [stepId]);
  useEffect(
    () =>
      registerBeforeLeave(async () => {
        if (busy.current && !navigating.current)
          throw new Error("Wait for this step to finish saving.");
        await persist();
      }),
    [persist, registerBeforeLeave],
  );
  const resetOwnDraft = useCallback(async () => {
    const base = revision.current;
    if (!base.draftRevision) return;
    if (!sessionId.current || !base.baseRevisions)
      throw new Error("The saved draft identity is unavailable.");
    const receipt = await propertySetupDraftResetApi.reset(propsRef.current.propertyId, {
      sessionId: sessionId.current,
      stepId,
      expectedTrackRevision: base.trackRevision,
      expectedSessionRevision: base.sessionRevision,
      expectedDraftRevision: base.draftRevision,
      expectedBaseRevisions: base.baseRevisions,
    } as Parameters<typeof propertySetupDraftResetApi.reset>[1]);
    revision.current = { ...base, sessionRevision: receipt.sessionRevision, draftRevision: 0 };
  }, [stepId]);
  useEffect(
    () =>
      registerStaleRecovery?.(
        async () => {
          if (busy.current) throw new Error("Wait for this step to finish saving.");
          busy.current = true;
          setSaving(true);
          try {
            const visible = propsRef.current;
            if ((visible.route.sessionRevision ?? 0) > revision.current.sessionRevision) {
              revision.current = adaptiveStepDraftRevision(visible.route, visible.step, stepId);
              sessionId.current = visible.route.sessionId;
            }
            try {
              await resetOwnDraft();
            } catch (cause) {
              if (cause instanceof PropertySetupDraftResetError && cause.requiresRefresh)
                await visible.refreshRoute();
              throw cause;
            }
            // The durable draft is gone: preserve answers before any fallible read.
            preserve.current = true;
            dirty.current = dirtyFields.current.size > 0;
            const fresh = await routeClient.getRoute(visible.propertyId, { cache: "no-store" });
            const next = fresh.steps.find((step) => step.stepId === stepId);
            if (!next || next.draft)
              throw new Error("This setup draft changed again. Refresh before resetting it.");
            revision.current = adaptiveStepDraftRevision(fresh, next, stepId);
            sessionId.current = fresh.sessionId;
            await visible.refreshRoute();
            setReload((value) => value + 1);
          } finally {
            busy.current = false;
            setSaving(false);
          }
        },
        step.draft ? "reset" : "refresh",
      ),
    [registerStaleRecovery, step.draft, resetOwnDraft, stepId],
  );

  async function commit(save: () => Promise<void>, continueAfterSave = true) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await persist();
      await save();
      await resetOwnDraft();
      dirty.current = false;
      dirtyFields.current.clear();
      if (continueAfterSave) {
        navigating.current = true;
        await propsRef.current.saveAndContinue();
      } else {
        const fresh = await routeClient.getRoute(propsRef.current.propertyId, {
          cache: "no-store",
        });
        const next = fresh.steps.find((step) => step.stepId === stepId);
        if (!next || next.draft)
          throw new Error("This setup draft changed again. Refresh before saving.");
        revision.current = adaptiveStepDraftRevision(fresh, next, stepId);
        sessionId.current = fresh.sessionId;
        await propsRef.current.refreshRoute();
      }
    } catch (cause) {
      if (
        isAdaptiveRevisionConflict(cause) ||
        (cause instanceof PropertySetupDraftResetError && cause.requiresRefresh)
      )
        propsRef.current.reportRevisionConflict();
      else setError(adaptiveStepErrorMessage(cause));
    } finally {
      navigating.current = false;
      busy.current = false;
      setSaving(false);
    }
  }
  return { data, values, revision, initialize, change, commit, saving, error, reload };
}
