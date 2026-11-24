import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import {
  chatView,
  roomBlockAction,
  routeAssistant,
  type PendingActionView,
} from "../support/assistantMocks";

// VAY-2519 part 2: vayada's Yes/No card for a change the AI asked for (VAY-2524), as on the
// approved boards 03 (card), 04 (waiting bar) and 07 (what the card turns into).
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const QUESTION = "Block room 12 from the 12th to the 14th, the shower needs fixing.";
const ANSWER =
  "Room 12 is free on those nights, so I can block it. Check the details below and tap Yes if they're right.";
const ids = (n: number) => `${String(n).padStart(8, "0")}-2e3f-4a5b-8c6d-7e8f9a0b1c2d`;
const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();
const now = () => new Date().toISOString();

async function openChat(page: Page, conversationId: string) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.addInitScript(
    ({ key, conversationId }) => {
      window.sessionStorage.setItem(key, conversationId);
      window.sessionStorage.setItem("vayada.assistant.open.pms", "1");
    },
    { key: `vayada.assistant.pms.${PMS_WEB_PROPERTY_ID}`, conversationId },
  );
}

/** A chat whose last turn asked for the change and waits for the person's answer. */
const waitingChat = (id: string, pendingActionId: string) =>
  chatView(id, [
    {
      question: QUESTION,
      tools: [
        { name: "calendar_days", result: "ok" },
        { name: "room_block_create", result: "ok", pendingActionId },
      ],
      answer: ANSWER,
      status: "waiting_for_answer",
    },
  ]);

const panelOf = (page: Page) => page.getByRole("complementary", { name: "Assistant" });
const cardOf = (page: Page) => panelOf(page).getByRole("region", { name: "Needs your answer" });
const shot = (page: Page, testInfo: TestInfo, name: string) =>
  page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

test.use({ viewport: DESKTOP });

test("a change waits for the person's Yes: the card, the waiting bar, then Done", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(1);
  await openChat(page, "c-change");
  const seen = await routeAssistant(page, {
    chats: [waitingChat("c-change", id)],
    pendingActions: { [id]: roomBlockAction(id, inFifteenMinutes()) },
    onAnswer: () => ({
      view: roomBlockAction(id, inFifteenMinutes(), {
        state: "done",
        answerBy: null,
        answeredAt: now(),
        finishedAt: now(),
        cardSha256: null,
      }),
    }),
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  const card = cardOf(page);
  await expect(card.getByRole("heading", { name: "Block room 12 for 3 nights?" })).toBeVisible();
  await expect(card).toContainText("12 · Deluxe Double");
  await expect(card).toContainText("What else happens");
  await expect(card).toContainText("Guests can't book room 12 on these nights.");
  await expect(card).toContainText(/Answer by \d\d:\d\d/);
  // The change's own call shows as the card, not as a "Looked something up" line.
  await expect(panel.getByText("Looked at the calendar")).toBeVisible();
  await expect(panel.getByText("Looked something up")).toHaveCount(0);
  const bar = panel.getByRole("status").filter({ hasText: "Waiting for your answer:" });
  await expect(bar).toContainText("Block room 12 for 3 nights");
  await shot(page, testInfo, "03-pms-yes-no-card");

  await card.getByRole("button", { name: "Yes, block room 12" }).click();
  await expect(panel.getByText("Blocked room 12 for 3 nights")).toBeVisible();
  await expect(panel.getByText(/You said yes at \d\d:\d\d\./)).toBeVisible();
  await expect(bar).toHaveCount(0);
  expect(seen.answers).toEqual([{ id, body: { answer: "yes", cardSha256: "a".repeat(64) } }]);
  await healthy();
});

test("the waiting bar stays while the person asks on, and Show brings the card back", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(2);
  await openChat(page, "c-bar");
  const later = "Is room 14 free those nights too?";
  const reply =
    "Yes, room 14 has no bookings on 12, 13 and 14 Dec. The block for room 12 is still waiting for your answer above.";
  const waiting = waitingChat("c-bar", id);
  await routeAssistant(page, {
    chats: [waiting],
    pendingActions: { [id]: roomBlockAction(id, inFifteenMinutes()) },
    answer: (request) => ({
      events: [
        { type: "turn", conversationId: "c-bar", turnId: "c-bar-turn-2" },
        { type: "text", text: reply },
        { type: "end", status: "done", reason: null },
      ],
      stored: {
        ...waiting,
        turns: [
          ...waiting.turns,
          { ...waiting.turns[0]!, id: "c-bar-turn-2", seq: 2, status: "done" },
        ],
        messages: [
          ...waiting.messages,
          {
            seq: 90,
            turnId: "c-bar-turn-2",
            message: { role: "user", content: request.question },
            createdAt: now(),
          },
          {
            seq: 91,
            turnId: "c-bar-turn-2",
            message: { role: "assistant", content: reply },
            createdAt: now(),
          },
        ],
      },
    }),
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  await expect(cardOf(page)).toBeVisible();
  await panel.getByRole("textbox").fill(later);
  await panel.getByRole("textbox").press("Enter");
  await expect(panel.getByText(reply)).toBeVisible();
  const bar = panel.getByRole("status").filter({ hasText: "Waiting for your answer:" });
  await expect(bar).toContainText(/until \d\d:\d\d/);
  await shot(page, testInfo, "04-pms-waiting");
  await bar.getByRole("button", { name: "Show" }).click();
  await expect(cardOf(page)).toBeInViewport();
  await healthy();
});

test("No closes the change, and nothing is made", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(3);
  await openChat(page, "c-no");
  const seen = await routeAssistant(page, {
    chats: [waitingChat("c-no", id)],
    pendingActions: { [id]: roomBlockAction(id, inFifteenMinutes()) },
    onAnswer: () => ({
      view: roomBlockAction(id, inFifteenMinutes(), {
        state: "declined",
        answerBy: null,
        answeredAt: now(),
        finishedAt: now(),
        cardSha256: null,
      }),
    }),
  });
  await page.goto("/dashboard");
  await cardOf(page).getByRole("button", { name: "No", exact: true }).click();
  const panel = panelOf(page);
  await expect(panel.getByText("Not done")).toBeVisible();
  await expect(panel.getByText(/You said no at \d\d:\d\d\. Nothing changed\./)).toBeVisible();
  expect(seen.answers).toEqual([{ id, body: { answer: "no" } }]);
  await healthy();
});

// No page-health watch here: the browser logs the refused answer's 409 as a console error.
test("a Yes refused because something changed shows it, and Ask again asks afresh", async ({
  page,
}) => {
  const id = ids(4);
  await openChat(page, "c-changed");
  const seen = await routeAssistant(page, {
    chats: [waitingChat("c-changed", id)],
    pendingActions: { [id]: roomBlockAction(id, inFifteenMinutes()) },
    onAnswer: () => ({
      view: roomBlockAction(id, inFifteenMinutes(), {
        state: "changed",
        answerBy: null,
        finishedAt: now(),
        cardSha256: null,
      }),
      refusal: { statusCode: 409, code: "changed" },
    }),
    answer: () => ({ events: [{ type: "refused", reason: "busy" }] }),
  });
  await page.goto("/dashboard");
  await cardOf(page).getByRole("button", { name: "Yes, block room 12" }).click();
  const panel = panelOf(page);
  await expect(panel.getByText("This changed since")).toBeVisible();
  await expect(
    panel.getByText("Nothing changed. Ask me again to see what's possible now."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Ask again" }).click();
  await expect.poll(() => seen.turns.map((turn) => turn.question)).toEqual([QUESTION]);
});

test("a change being made is read again until it is done", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(6);
  await openChat(page, "c-running");
  const fake = await routeAssistant(page, {
    chats: [waitingChat("c-running", id)],
    pendingActions: {
      [id]: roomBlockAction(id, inFifteenMinutes(), {
        state: "running",
        answerBy: null,
        answeredAt: now(),
        cardSha256: null,
      }),
    },
  });
  await page.goto("/dashboard");
  const card = cardOf(page);
  await expect(card.getByText("Making the change...")).toBeVisible();
  await expect(card.getByRole("button", { name: "Yes, block room 12" })).toHaveCount(0);
  fake.setPendingAction(
    id,
    roomBlockAction(id, inFifteenMinutes(), {
      state: "done",
      answerBy: null,
      answeredAt: now(),
      finishedAt: now(),
      cardSha256: null,
    }),
  );
  await expect(panelOf(page).getByText("Blocked room 12 for 3 nights")).toBeVisible({
    timeout: 10_000,
  });
  await healthy();
});

test("a card vayada can't bind a Yes to has no Yes", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  const id = ids(7);
  await openChat(page, "c-unbound");
  await routeAssistant(page, {
    chats: [waitingChat("c-unbound", id)],
    pendingActions: {
      [id]: roomBlockAction(id, inFifteenMinutes(), { card: null, cardSha256: null }),
    },
  });
  await page.goto("/dashboard");
  const card = cardOf(page);
  await expect(card).toContainText("is gone or hidden from you now");
  await expect(card.getByRole("button")).toHaveCount(0);
  await healthy();
});

// No page-health watch: the browser logs the lost answer's 503 as a console error.
test("an answer whose reply was lost is never called failed: the card reads the change again", async ({
  page,
}) => {
  const id = ids(8);
  const waitingView = roomBlockAction(id, inFifteenMinutes());
  await openChat(page, "c-lost");
  const fake = await routeAssistant(page, {
    chats: [waitingChat("c-lost", id)],
    pendingActions: { [id]: waitingView },
    // The reply never comes back (onAnswer gives nothing: a 503 without the change).
  });
  await page.goto("/dashboard");
  const card = cardOf(page);
  // 1. It still waits: the answer didn't get through, and Yes can be pressed again.
  await card.getByRole("button", { name: "Yes, block room 12" }).click();
  await expect(card.getByRole("alert")).toHaveText(
    "Your answer didn't get through. Nothing changed. Try again.",
  );
  await expect(card.getByRole("button", { name: "Yes, block room 12" })).toBeVisible();
  // 2. It ran before the reply was lost: the card shows Done, never "Nothing changed".
  fake.setPendingAction(
    id,
    roomBlockAction(id, inFifteenMinutes(), {
      state: "done",
      answerBy: null,
      answeredAt: now(),
      finishedAt: now(),
      cardSha256: null,
    }),
  );
  await card.getByRole("button", { name: "Yes, block room 12" }).click();
  const panel = panelOf(page);
  await expect(panel.getByText("Blocked room 12 for 3 nights")).toBeVisible();
  await expect(panel.getByText(/Nothing changed/)).toHaveCount(0);
  expect(fake.answers).toHaveLength(2);
});

test("every outcome reads as on board 07", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await openChat(page, "c-outcomes");
  const states: [string, Partial<PendingActionView>][] = [
    ["done", { answeredAt: now() }],
    ["declined", { answeredAt: now() }],
    ["expired", {}],
    ["not_allowed", {}],
    ["stopped", {}],
    ["changed", {}],
    ["failed", { answeredAt: now() }],
    ["unsure", { answeredAt: now() }],
  ];
  const actions = Object.fromEntries(
    states.map(([state, changes], index) => [
      ids(10 + index),
      roomBlockAction(ids(10 + index), inFifteenMinutes(), {
        state,
        answerBy: null,
        finishedAt: now(),
        cardSha256: null,
        ...changes,
      }),
    ]),
  );
  await routeAssistant(page, {
    chats: [
      chatView(
        "c-outcomes",
        states.map((_, index) => ({
          question: `Block room 12, try ${index + 1}`,
          tools: [
            { name: "room_block_create", result: "ok" as const, pendingActionId: ids(10 + index) },
          ],
          status: "waiting_for_answer" as const,
        })),
      ),
    ],
    pendingActions: actions,
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  for (const label of [
    "Done",
    "Not done",
    "Expired",
    "Not allowed anymore",
    "This changed since",
    "Stopped",
    "Couldn't finish",
    "Not sure it happened",
  ])
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  // Nothing waits any more: no bar, no Yes.
  await expect(panel.getByText("Waiting for your answer:")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Yes, block room 12" })).toHaveCount(0);
  await shot(page, testInfo, "07-card-outcomes");
  await healthy();
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE });

  test("the card fits the sheet", async ({ page }, testInfo) => {
    const healthy = watchPageHealth(page, testInfo);
    const id = ids(5);
    await openChat(page, "c-phone-card");
    await routeAssistant(page, {
      chats: [waitingChat("c-phone-card", id)],
      pendingActions: { [id]: roomBlockAction(id, inFifteenMinutes()) },
    });
    await page.goto("/dashboard");
    const sheet = page.getByRole("dialog", { name: "Assistant" });
    const card = sheet.getByRole("region", { name: "Needs your answer" });
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("button", { name: "Yes, block room 12" })).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    await shot(page, testInfo, "13-phone-yes-no");
    await healthy();
  });
});
