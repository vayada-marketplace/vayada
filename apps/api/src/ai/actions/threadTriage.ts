// Marking a guest conversation done, for follow-up or open again (VAY-2522, first change batch).
import { z } from "zod";

import { defineChangeAction, sameRecordId } from "./defineChangeAction.js";

const thread = z.object({ thread: z.object({ id: z.string(), version: z.number() }) });

const shared = {
  version: 1,
  pathParams: { threadId: z.uuid() },
  // The thread's version: a conversation that changed meanwhile is refused, not overwritten.
  idempotency: { in: "header" },
  preconditions: ["expectedThreadVersion"],
  // The conversation's version; one message is the least the route reads, and only the version is
  // kept.
  currentState: {
    route: "GET /api/pms/properties/:propertyId/messaging/threads/:threadId",
    query: { messageLimit: 1 },
    pick(answer: unknown, input: Readonly<Record<string, unknown>>) {
      const { id, version } = thread.parse(answer).thread;
      return sameRecordId(id, input.threadId) ? { expectedThreadVersion: version } : null;
    },
  },
  authoritySites: ["pms_inbox_triage_scope"],
  group: "ask",
  permission: "pms.inbox.reply",
  alsoNeeds: ["pms.inbox.read"],
  output: z.object({
    propertyId: z.string(),
    threadId: z.string(),
    attentionState: z.enum(["needs_attention", "follow_up", "done"]),
    followUpAt: z.string().nullable(),
    threadVersion: z.number(),
  }),
  surfaces: [],
  contractVersion: "native-guest-inbox.v2",
  reviewedBy: "VAY-2522",
} as const;
const expectedThreadVersion = z.number().int().min(1);

export const threadMarkDone = defineChangeAction({
  ...shared,
  name: "thread_mark_done",
  description:
    "Marks one guest conversation of a property as done, so it leaves the list of conversations " +
    "that need an answer. The person confirms it in vayada before it runs.",
  route: "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/done",
  body: z.strictObject({ expectedThreadVersion }),
});

export const threadFollowUp = defineChangeAction({
  ...shared,
  name: "thread_follow_up",
  description:
    "Sets one guest conversation of a property aside until a later time (UTC, with " +
    "milliseconds), when it needs an answer again. The person confirms it in vayada before it " +
    "runs.",
  route: "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/follow-up",
  body: z.strictObject({
    expectedThreadVersion,
    followUpAt: z.iso.datetime({ precision: 3 }),
  }),
});

export const threadReopen = defineChangeAction({
  ...shared,
  name: "thread_reopen",
  description:
    "Opens a guest conversation of a property again, so it is back in the list of conversations " +
    "that need an answer. The person confirms it in vayada before it runs.",
  route: "POST /api/pms/properties/:propertyId/messaging/threads/:threadId/reopen",
  body: z.strictObject({ expectedThreadVersion }),
});
