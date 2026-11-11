import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

// The flows from the test-layout ticket, against the real Worker (opennextjs-cloudflare preview, wrangler `e2e` env).
// Lots are seeded through the e2e-only fixture (src/e2e-seed.ts), which plans them with the pipeline's own planLots.

async function seedLot(request: APIRequestContext, drugId = "cefazolin", quantity = 200): Promise<string> {
  const res = await request.post("/api/e2e/seed", { data: { drugId, quantity } });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { lots: { lotId: string; action: string }[] };
  expect(body.lots[0]?.action).toBe("propose");
  return body.lots[0]!.lotId;
}

async function signIn(page: Page, who: RegExp) {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("button", { name: who }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
}

async function deskAs(browser: Browser, who: RegExp) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, who);
  return page;
}

const lot = (page: Page, lotId: string) => page.locator(`article[data-lot-id="${lotId}"]`);

async function openLot(page: Page, lotId: string) {
  const head = lot(page, lotId).locator("button.lot-head");
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(lot(page, lotId).locator("form.editor")).toBeVisible();
}

/** Enter `qty` for the first site and 0 everywhere else. */
async function allocateToFirstSite(page: Page, lotId: string, qty: number) {
  const inputs = lot(page, lotId).getByRole("spinbutton");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) await inputs.nth(i).fill(i === 0 ? String(qty) : "0");
}

test("the landing page is served from the static-assets cache", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-opennext-cache"]).toBe("HIT");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Every scarce vial");
});

test("signing in as a persona sets the cookie and opens the desk", async ({ page, context }) => {
  await signIn(page, /Sign in as Olu Adeyemi/);
  const cookie = (await context.cookies()).find((c) => c.name === "demo_user");
  expect(cookie?.httpOnly).toBe(true);
  expect(decodeURIComponent(cookie?.value ?? "")).toBe("olu@shortstop.demo");
  await expect(page.getByRole("combobox", { name: "Viewing as" })).toHaveValue("olu@shortstop.demo");
  await page.getByRole("link", { name: "Metrics" }).click();
  await expect(page.getByRole("link", { name: "Metrics" })).toHaveAttribute("aria-current", "page");
});

// Runs before any test seeds lots: the guide only shows on an empty board.
test("the start guide submits a sample in one click, and closes for good", async ({ page }) => {
  await signIn(page, /Sign in as Olu Adeyemi/);
  const guide = page.locator("section.start-guide");
  await guide.getByRole("button", { name: "Multi-lot notice" }).click();
  await expect(guide.getByText("already submitted")).toBeVisible();
  await expect(page.locator(".notice-strip").getByText("01-meridian-multi-lot.txt", { exact: true })).toBeVisible();
  await guide.getByRole("button", { name: "Close the guide" }).click();
  await expect(guide).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Show the guide" })).toBeVisible();
  await expect(guide).toHaveCount(0);
});

test("the board renders and a planner commits through the form", async ({ page, request }) => {
  const lotId = await seedLot(request);
  await signIn(page, /Sign in as Priya Raman/);
  await openLot(page, lotId);
  await lot(page, lotId).getByRole("button", { name: /^Commit 200 vials$/ }).click();
  await lot(page, lotId).getByRole("button", { name: "Confirm commit" }).click();
  await expect(lot(page, lotId).getByText(/^Committed 200 vials to \d+ sites\.$/)).toBeVisible();
  await expect(lot(page, lotId).locator(".chip")).toHaveText("Committed");
});

test("cover after commit follows the quantity typed, not the proposal", async ({ page, request }) => {
  const lotId = await seedLot(request);
  await signIn(page, /Sign in as Priya Raman/);
  await openLot(page, lotId);
  const firstRow = lot(page, lotId).locator("form.editor tbody tr").first();
  const cover = firstRow.getByRole("img", { name: /days of cover after the split/ });
  const input = firstRow.getByRole("spinbutton");
  const days = async () => Number((await cover.getAttribute("aria-label"))!.match(/^([\d.]+) days/)![1]);
  await input.fill("0");
  const atZero = await days();
  await input.fill("100");
  await expect.poll(days).toBeGreaterThan(atZero);
  await input.fill("0");
  await expect.poll(days).toBe(atZero);
  // "Now" shows the site's stock before this lot, and its days match the cover with nothing allocated.
  const now = firstRow.getByLabel(/vials now, [\d.]+ days of cover/);
  await expect(now).toBeVisible();
  const nowDays = Number((await now.getAttribute("aria-label"))!.match(/([\d.]+) days of cover/)![1]);
  expect(nowDays).toBe(atZero);
});

test("a commit by one planner reaches the other tab over the WebSocket and rebases its open split", async ({ browser, request }) => {
  const lotId = await seedLot(request);
  const a = await deskAs(browser, /Sign in as Priya Raman/);
  const b = await deskAs(browser, /Sign in as Marcus Webb/);
  await openLot(a, lotId);
  await openLot(b, lotId);

  await allocateToFirstSite(a, lotId, 10);
  await lot(a, lotId).getByRole("button", { name: /^Commit 10 vials$/ }).click();
  await lot(a, lotId).getByRole("button", { name: "Confirm commit" }).click();
  await expect(lot(a, lotId).getByText(/^Committed 10 vials to 1 site\.$/)).toBeVisible();

  // No reload in tab B: the BoardDO event triggers router.refresh().
  await expect(lot(b, lotId).locator(".qty b")).toHaveText("190");
  await expect(lot(b, lotId).getByRole("status").filter({ hasText: "190 vials are left; the split is updated" })).toBeVisible();
  await expect(lot(b, lotId).getByRole("button", { name: /^Commit 190 vials$/ })).toBeVisible();
});

test("two planners race for the same lot: one commit lands, the loser sees the updated split", async ({ browser, request }) => {
  const lotId = await seedLot(request);
  const tabs = [await deskAs(browser, /Sign in as Priya Raman/), await deskAs(browser, /Sign in as Marcus Webb/)];
  for (const t of tabs) {
    await openLot(t, lotId);
    await allocateToFirstSite(t, lotId, 150);
    await lot(t, lotId).getByRole("button", { name: /^Commit 150 vials$/ }).click();
  }
  // Click both confirms in-page at once: a Playwright click waits for actionability, and by then the winner's live
  // refresh has already rebased the other tab (which is the point of the next test, not this one).
  const confirms = await Promise.all(tabs.map((t) => lot(t, lotId).getByRole("button", { name: "Confirm commit" }).elementHandle()));
  await Promise.all(confirms.map((b) => b!.evaluate((el) => (el as HTMLButtonElement).click())));

  // Each tab settles: its commit landed, or it was rebased onto the 50 left (the commit came back 409 with the rebased
  // proposal, or the live refresh got there first). The winner can show the rebase notice too, because the loser's
  // refusal broadcasts `lot.rebased` to every board, so wait for either with `.first()`; the asserts below then
  // check that exactly one tab landed and the other was rebased.
  const landed = (t: Page) => lot(t, lotId).getByText(/^Committed 150 vials to 1 site\.$/);
  const rebased = (t: Page) => lot(t, lotId).getByRole("status").filter({ hasText: "50 vials are left; the split is updated" });
  for (const t of tabs) await expect(landed(t).or(rebased(t)).first()).toBeVisible();
  const won = await Promise.all(tabs.map((t) => landed(t).isVisible()));
  expect(won.filter(Boolean)).toHaveLength(1);
  const loser = tabs[won.indexOf(false)]!;
  await expect(rebased(loser)).toBeVisible();
  await expect(lot(loser, lotId).locator(".qty b")).toHaveText("50");
});

test("an intake upload is stored and shows as received", async ({ page }) => {
  await signIn(page, /Sign in as Priya Raman/);
  await page.getByRole("link", { name: "New notice" }).click();
  await expect(page).toHaveURL(/\/app\/intake$/);
  await page.getByRole("textbox", { name: "Notice text" }).fill("ALLOCATION NOTICE\nCefazolin 1 g vial: 120 vials, ETA Friday.");
  await page.getByRole("button", { name: "Submit notice" }).click();
  await expect(page).toHaveURL(/\/app$/);
  const strip = page.getByLabel("Notices not yet on the board");
  await expect(strip.locator(".notice-row").filter({ hasText: "pasted.txt" }).first().locator(".chip")).toHaveText("Received");
});

test("a planner dismisses a triage notice with a reason; a pharmacist can't", async ({ browser, request }) => {
  const res = await request.post("/api/e2e/seed", { data: { triage: "unmatched product: Bumetanide Injection" } });
  expect(res.ok()).toBe(true);
  const { noticeId } = (await res.json()) as { noticeId: string };

  const pharmacist = await deskAs(browser, /Sign in as Dana Okafor/);
  await pharmacist.getByRole("button", { name: /^All/ }).click();
  const seen = pharmacist.locator(`[data-notice-id="${noticeId}"]`);
  await expect(seen).toContainText("Bumetanide Injection isn't in the catalog");
  await expect(seen.getByRole("button", { name: "Dismiss" })).toHaveCount(0);

  const page = await deskAs(browser, /Sign in as Priya Raman/);
  const row = page.locator(`[data-notice-id="${noticeId}"]`);
  await expect(row).toContainText("Bumetanide Injection isn't in the catalog");
  await row.getByRole("button", { name: "Dismiss" }).click();
  await row.getByRole("button", { name: "Confirm dismiss" }).click();
  await expect(row.getByRole("alert")).toContainText("say why");
  await row.getByRole("textbox", { name: "Reason for dismissing" }).fill("Not stocked here");
  await row.getByRole("button", { name: "Confirm dismiss" }).click();
  await expect(row).toHaveCount(0);
  // The other tab drops it too, over the WebSocket.
  await expect(seen).toHaveCount(0);
});

test("saving the policy previews which lots move, and saves on confirm", async ({ page, request }) => {
  await seedLot(request);
  await signIn(page, /Sign in as Olu Adeyemi/);
  await page.getByRole("link", { name: "Autopilot policy" }).click();
  await expect(page).toHaveURL(/\/app\/policy$/);

  // Without antibiotics-propose (rule 2), the open cefazolin lots fall to small-confident-auto.
  await page.getByRole("button", { name: "Delete rule" }).nth(1).click();
  await page.getByRole("button", { name: "Save as new version" }).click();
  const panel = page.getByRole("group", { name: /This save moves \d+ lots? to autopilot\./ });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/cefazolin/i);
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toHaveCount(0);

  // Unchanged rules move nothing, and still save after the confirm.
  await page.reload();
  await page.getByRole("button", { name: "Save as new version" }).click();
  const same = page.getByRole("group", { name: "No open lots change." });
  await expect(same).toBeVisible();
  await same.getByRole("button", { name: "Confirm save" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved as v\d+\. No open lots changed\.$/ })).toBeVisible();
});

// Last: it changes the policy for good.
test("a policy save that moves an open lot to autopilot tells the planner who has it open", async ({ browser, request }) => {
  const lotId = await seedLot(request);
  const planner = await deskAs(browser, /Sign in as Priya Raman/);
  await openLot(planner, lotId);

  const ops = await deskAs(browser, /Sign in as Olu Adeyemi/);
  await ops.goto("/app/policy");
  await ops.getByRole("button", { name: "Delete rule" }).nth(1).click();
  await ops.getByRole("button", { name: "Save as new version" }).click();
  await ops.getByRole("button", { name: "Confirm save" }).click();
  await expect(ops.getByRole("status").filter({ hasText: /Moved \d+ lots? to autopilot\./ })).toBeVisible();

  await expect(lot(planner, lotId).getByText(/^Policy v\d+ moved this lot to autopilot\. Use Edit split to take it back\.$/)).toBeVisible();
  await expect(lot(planner, lotId).locator(".chip")).toHaveText("Autopilot pending");
});
