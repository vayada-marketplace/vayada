import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { chatView, routeAssistant } from "../support/assistantMocks";

// VAY-2519: the in-app assistant's panel in PMS, as on the approved Paper boards (VAY-2517).
// The shared PMS mocks' property and person.
const HOTEL = "Alpenrose Munich";
const GREETING = "Hi PMS, what do you need?";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function setup(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
}

/** A chat remembered by this tab (as after a reload), with the panel open. */
async function rememberChat(page: Page, conversationId: string) {
  await page.addInitScript(
    ({ key, conversationId }) => {
      window.sessionStorage.setItem(key, conversationId);
      window.sessionStorage.setItem("vayada.assistant.open.pms", "1");
    },
    { key: `vayada.assistant.pms.${PMS_WEB_PROPERTY_ID}`, conversationId },
  );
}

const panelOf = (page: Page) => page.getByRole("complementary", { name: "Assistant" });

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

const answered = (id: string, question: string, answer: string) => ({
  events: [
    { type: "turn", conversationId: id, turnId: `${id}-turn-1` },
    { type: "tool", toolCallId: "c1", name: "calendar_days", status: "running" },
    { type: "tool", toolCallId: "c1", name: "calendar_days", status: "ok" },
    { type: "text", text: answer },
    { type: "end", status: "done", reason: null },
  ],
  stored: chatView(id, [{ question, tools: [{ name: "calendar_days", result: "ok" }], answer }]),
});

test.use({ viewport: DESKTOP });

test("shows no Ask AI while the assistant is switched off", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const probe = page.waitForResponse(/\/api\/ai\/assistant\/conversations\?/);
  await page.goto("/dashboard");
  expect((await probe).status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
  await expect(panelOf(page)).toHaveCount(0);
  await healthy();
});

test("opens beside the page, answers a suggestion as plain text and continues the chat", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const answer = "Room 7 and Room 12 are free tonight. <b>Not bold</b> https://example.com";
  const seen = await routeAssistant(page, {
    answer: (request, call) =>
      call === 1
        ? answered("c-new", request.question, answer)
        : {
            events: [
              { type: "turn", conversationId: "c-new", turnId: "c-new-turn-2" },
              { type: "text", text: "Yes, both." },
              { type: "end", status: "done", reason: null },
            ],
            stored: chatView("c-new", [
              {
                question: "What arrives today?",
                tools: [{ name: "calendar_days", result: "ok" }],
                answer,
              },
              { question: request.question, answer: "Yes, both." },
            ]),
          },
  });
  await page.goto("/dashboard");
  const main = page.locator("main");
  const before = (await main.boundingBox())!.width;

  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: GREETING })).toBeVisible();
  await expect(panel).toContainText(HOTEL);
  await expect(panel.getByRole("textbox")).toHaveAttribute(
    "placeholder",
    `Ask anything about ${HOTEL}...`,
  );
  await expect(panel.getByRole("textbox")).toBeFocused();
  // The drawer pushes the page aside: 420 px on the right, the page 420 px narrower.
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.width)).toBe(420);
  expect(Math.round(box.x + box.width)).toBe(DESKTOP.width);
  expect(Math.round(before - (await main.boundingBox())!.width)).toBe(420);
  await shot(page, testInfo, "01-pms-empty");

  await panel.getByRole("button", { name: "What arrives today?" }).click();
  await expect(panel.getByText("Looked at the calendar")).toBeVisible();
  await expect(panel.getByText(answer)).toBeVisible();
  // AI text stays text: no bold, no link.
  await expect(panel.locator("b, a")).toHaveCount(0);
  expect(seen.turns[0]).toEqual({
    propertyId: PMS_WEB_PROPERTY_ID,
    app: "pms",
    question: "What arrives today?",
  });
  await shot(page, testInfo, "02-pms-answer");

  await panel.getByRole("textbox").fill("Both with a balcony?");
  await panel.getByRole("textbox").press("Enter");
  await expect(panel.getByText("Yes, both.")).toBeVisible();
  expect(seen.turns[1]).toMatchObject({
    question: "Both with a balcony?",
    conversationId: "c-new",
  });

  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask AI" })).toBeFocused();
  expect(Math.round((await main.boundingBox())!.width)).toBe(Math.round(before));
  await healthy();
});

test("after a reload follows the answer still running, and Stop stops it", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await rememberChat(page, "c-run");
  const question = "Which room is free for Emma tonight?";
  const seen = await routeAssistant(page, {
    chats: [
      chatView("c-run", [{ question, tools: [{ name: "calendar_days" }], status: "running" }]),
    ],
    onStop: () =>
      chatView("c-run", [
        {
          question,
          tools: [{ name: "calendar_days", result: "not_run" }],
          status: "stopped",
          endReason: "user_stopped",
        },
      ]),
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  await expect(panel.getByText(question)).toBeVisible();
  await expect(panel.getByText("Looking at the calendar...")).toBeVisible();
  await panel.getByRole("button", { name: "Stop" }).click();
  await expect(panel.getByText("You stopped this answer.")).toBeVisible();
  await expect(panel.getByText("Didn't get to this")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
  expect(seen.stops).toEqual([
    { propertyId: PMS_WEB_PROPERTY_ID, app: "pms", turnId: "c-run-turn-1" },
  ]);
  await healthy();
});

test("a cut-off answer can be asked again", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await rememberChat(page, "c-cut");
  const question = "Summarise this week's arrivals with special requests";
  const seen = await routeAssistant(page, {
    chats: [
      chatView("c-cut", [
        {
          question,
          tools: [{ name: "calendar_days", result: "ok" }],
          answer:
            "14 guests arrive this week. Three have special requests: Lukas Brandt asks for a quiet room, and...",
          status: "interrupted",
          endReason: "shutdown",
        },
      ]),
    ],
    answer: (request) => answered("c-cut", request.question, "Done this time."),
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  await expect(panel.getByText("This answer was cut off")).toBeVisible();
  await shot(page, testInfo, "09-1-cut-off");
  await panel.getByRole("button", { name: "Ask again" }).click();
  await expect(panel.getByText("Done this time.")).toBeVisible();
  expect(seen.turns[0]).toMatchObject({ question, conversationId: "c-cut" });
  await healthy();
});

test("a dropped connection reloads the chat from vayada", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const question = "How full are we in January compared with last year?";
  const answer = "January is 46% booked so far. On the same day last year it was 39%.";
  await routeAssistant(page, {
    answer: () => ({
      // The stream ends before the turn did; the stored chat has the whole answer.
      events: [
        { type: "turn", conversationId: "c-drop", turnId: "c-drop-turn-1" },
        { type: "text", text: "January is 46%" },
      ],
      stored: chatView("c-drop", [{ question, answer }]),
    }),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("textbox").fill(question);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText(answer)).toBeVisible();
  await expect(panel.getByText(/The connection dropped, so we reloaded this chat/)).toBeVisible();
  await shot(page, testInfo, "09-2-reloaded");
  await healthy();
});

test("switched off for the account: the panel says so and nothing can be asked", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await routeAssistant(page, {
    answer: () => ({ events: [{ type: "refused", reason: "unavailable" }] }),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "What arrives today?" }).click();
  await expect(panel.getByText("AI is switched off for this account")).toBeVisible();
  await expect(panel.getByRole("textbox")).toBeDisabled();
  await expect(panel.getByRole("textbox")).toHaveAttribute("placeholder", "AI is switched off");
  await expect(panel.getByRole("button", { name: "New chat" })).toBeDisabled();
  await shot(page, testInfo, "09-3-switched-off");
  await healthy();
});

test("a chat that can't continue offers a new chat", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await rememberChat(page, "c-old");
  await routeAssistant(page, {
    chats: [
      chatView(
        "c-old",
        [
          {
            question: "How full are we in January compared with last year?",
            answer: "January is 46% booked so far. On the same day last year it was 39%.",
          },
        ],
        "contract_changed",
      ),
    ],
  });
  await page.goto("/dashboard");
  const panel = panelOf(page);
  await expect(panel.getByText("This chat can't continue")).toBeVisible();
  await expect(panel.getByRole("textbox")).toBeDisabled();
  await expect(panel.getByRole("textbox")).toHaveAttribute(
    "placeholder",
    "Start a new chat to continue",
  );
  await shot(page, testInfo, "09-4-read-only");
  await panel.getByRole("button", { name: "Start a new chat" }).click();
  await expect(panel.getByRole("heading", { name: GREETING })).toBeVisible();
  await expect(panel.getByRole("textbox")).toBeEnabled();
  await healthy();
});

test("busy: Try again asks the same question again", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const question = "Who checks out tomorrow?";
  const seen = await routeAssistant(page, {
    answer: (request, call) =>
      call === 1
        ? { events: [{ type: "refused", reason: "busy" }] }
        : answered("c-busy", request.question, "Two guests check out tomorrow."),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("textbox").fill(question);
  await panel.getByRole("textbox").press("Enter");
  await expect(panel.getByText("The assistant is busy right now")).toBeVisible();
  // Nothing was stored, but the question stays above the notice (board 09, panel 5).
  await expect(panel.getByText(question)).toBeVisible();
  await expect(panel.getByRole("heading", { name: GREETING })).toHaveCount(0);
  await shot(page, testInfo, "09-5-busy");
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.getByText("Two guests check out tomorrow.")).toBeVisible();
  expect(seen.turns.map((turn) => turn.question)).toEqual([question, question]);
  await healthy();
});

test("allowance used up (B): paused with Contact vayada", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await routeAssistant(page, {
    answer: (request) => ({
      events: [
        { type: "turn", conversationId: "c-paid", turnId: "c-paid-turn-1" },
        { type: "end", status: "failed", reason: "allowance_used_up" },
      ],
      stored: chatView("c-paid", [
        { question: request.question, status: "failed", endReason: "allowance_used_up" },
      ]),
    }),
  });
  await page.clock.setFixedTime(new Date("2026-12-14T10:00:00"));
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "What arrives today?" }).click();
  await expect(panel.getByText("Your AI allowance for December is used up")).toBeVisible();
  await expect(panel).toContainText(
    "before the allowance resets on 1 January, ask vayada to raise it",
  );
  await expect(panel.getByRole("textbox")).toHaveAttribute(
    "placeholder",
    "Paused until vayada raises it or 1 January",
  );
  await expect(panel.getByRole("button", { name: "New chat" })).toBeDisabled();
  await shot(page, testInfo, "10-allowance-B");
  await panel.getByRole("button", { name: "Contact vayada" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await healthy();
});

test("Your chats lists the person's chats and opens one", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  await routeAssistant(page, {
    chats: [
      chatView("c-a", [{ question: "What arrives today?", answer: "Four guests arrive today." }]),
      chatView(
        "c-b",
        [{ question: "Which rooms are closed?", answer: "None are closed." }],
        "too_long",
      ),
    ],
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Your chats" }).click();
  await expect(panel.getByRole("heading", { name: "Your chats" })).toBeVisible();
  await panel.getByRole("button", { name: /Which rooms are closed\?/ }).click();
  await expect(panel.getByText("None are closed.")).toBeVisible();
  await expect(
    panel.getByText("This chat is too long to continue. Start a new chat to keep going."),
  ).toBeVisible();
  await healthy();
});

/** A promise the spec settles itself: holds an answer or a read while it looks at the panel. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

test("Stop pressed before the answer starts stops it as soon as it does", async ({
  page,
}, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const slow = gate();
  const question = "Which rooms are free tonight?";
  const seen = await routeAssistant(page, {
    answer: () => ({
      wait: slow.opened,
      events: [
        { type: "turn", conversationId: "c-stop", turnId: "c-stop-turn-1" },
        { type: "end", status: "stopped", reason: "user_stopped" },
      ],
      stored: chatView("c-stop", [{ question, status: "stopped", endReason: "user_stopped" }]),
    }),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("textbox").fill(question);
  await panel.getByRole("textbox").press("Enter");
  await expect(panel.getByText("Thinking...")).toBeVisible();
  await panel.getByRole("button", { name: "Stop" }).click();
  expect(seen.stops).toEqual([]);
  slow.open();
  await expect(panel.getByText("You stopped this answer.")).toBeVisible();
  await expect
    .poll(() => seen.stops)
    .toEqual([{ propertyId: PMS_WEB_PROPERTY_ID, app: "pms", turnId: "c-stop-turn-1" }]);
  // Stop is gone: the question box has the focus again.
  await expect(panel.getByRole("textbox")).toBeFocused();
  await healthy();
});

test("opening another chat while an answer runs keeps that chat", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const slow = gate();
  const seen = await routeAssistant(page, {
    chats: [
      chatView("c-old", [{ question: "Which rooms are closed?", answer: "None are closed." }]),
    ],
    answer: (request, call) =>
      call === 1
        ? {
            wait: slow.opened,
            events: [
              { type: "turn", conversationId: "c-late", turnId: "c-late-turn-1" },
              { type: "text", text: "A late answer for the other chat." },
              { type: "end", status: "done", reason: null },
            ],
            stored: chatView("c-late", [
              { question: request.question, answer: "A late answer for the other chat." },
            ]),
          }
        : answered("c-old", request.question, "Still none."),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "What arrives today?" }).click();
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();
  await panel.getByRole("button", { name: "Your chats" }).click();
  await panel.getByRole("button", { name: /Which rooms are closed\?/ }).click();
  await expect(panel.getByText("None are closed.")).toBeVisible();
  const late = page.waitForResponse(/\/api\/ai\/assistant\/turns/);
  slow.open();
  await late;
  // The other chat's late answer never shows here, and the next question goes to this chat.
  await panel.getByRole("textbox").fill("And tomorrow?");
  await panel.getByRole("textbox").press("Enter");
  await expect(panel.getByText("Still none.")).toBeVisible();
  await expect(panel.getByText("A late answer for the other chat.")).toHaveCount(0);
  expect(seen.turns[1]).toMatchObject({ question: "And tomorrow?", conversationId: "c-old" });
  await healthy();
});

test("the answer stays on screen while the chat is read back", async ({ page }, testInfo) => {
  const healthy = watchPageHealth(page, testInfo);
  await setup(page);
  const reading = gate();
  const answer = "Four guests arrive today.";
  await routeAssistant(page, {
    answer: (request) => answered("c-hold", request.question, answer),
    holdRead: (id) => (id === "c-hold" ? reading.opened : undefined),
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask AI" }).click();
  const panel = panelOf(page);
  const readBack = page.waitForRequest(/\/api\/ai\/assistant\/conversations\/c-hold\?/);
  await panel.getByRole("button", { name: "What arrives today?" }).click();
  await readBack;
  await expect(panel.getByText(answer)).toBeVisible();
  // The stream has ended and the chat is being read: no greeting, the answer is still there.
  await expect(panel.getByRole("heading", { name: GREETING })).toHaveCount(0);
  reading.open();
  await expect(panel.getByText("Looked at the calendar")).toBeVisible();
  await expect(panel.getByText(answer)).toBeVisible();
  await healthy();
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE });

  test("opens as a full-screen sheet", async ({ page }, testInfo) => {
    const healthy = watchPageHealth(page, testInfo);
    await setup(page);
    await routeAssistant(page, {
      answer: (request) =>
        answered(
          "c-phone",
          request.question,
          "4 guests arrive today. Anna Keller still owes €360.",
        ),
    });
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Ask AI" }).click();
    // On a phone the panel covers the page: a modal dialog.
    const panel = page.getByRole("dialog", { name: "Assistant" });
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(panel.getByRole("heading", { name: GREETING })).toBeVisible();
    expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, ...PHONE });
    // Tab stays inside the sheet.
    await panel.getByRole("button", { name: "Close" }).focus();
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      expect(await panel.evaluate((sheet) => sheet.contains(document.activeElement))).toBe(true);
    }
    await shot(page, testInfo, "11-phone-empty");
    await panel.getByRole("button", { name: "What arrives today?" }).click();
    await expect(panel.getByText("Anna Keller still owes €360.", { exact: false })).toBeVisible();
    await shot(page, testInfo, "12-phone-answer");
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
    await healthy();
  });
});
