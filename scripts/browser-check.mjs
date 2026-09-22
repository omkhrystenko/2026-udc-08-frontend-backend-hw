// Browser-level checks for the archive feature: what green API tests cannot
// see. Drives a real Chrome through Playwright and runs axe-core on the page.
//
//   cd app && npm run dev                 # in one terminal (fresh notes.db!)
//   cd scripts && npm install && npm run check
//
// BASE overrides the URL (default http://localhost:3080). The script mutates
// data, so run it against a freshly seeded database: delete app/notes.db first.

import { chromium } from "playwright-core";
import { AxeBuilder } from "@axe-core/playwright";

const BASE = process.env.BASE ?? "http://localhost:3080";
const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
};

// The view switch may be built as tabs, radios or plain buttons; accept any.
async function viewControl(page, name) {
  for (const role of ["tab", "radio", "button"]) {
    const control = page.getByRole(role, { name, exact: true });
    if ((await control.count()) > 0) return control;
  }
  throw new Error(`no view control named "${name}"`);
}

// Text currently held by any live region (role=status/alert or aria-live).
async function liveRegionText(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
      .map((e) => e.textContent.trim())
      .filter(Boolean)
      .join(" | "),
  );
}

// "BODY" means nothing on the page holds focus. After an action that is a
// bug (focus was lost); at the end of a Tab walk it is just the page's end.
async function describeFocus(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "BODY";
    const label =
      el.getAttribute("aria-label") ||
      el.labels?.[0]?.textContent.trim() ||
      el.textContent.trim().replace(/\s+/g, " ");
    const kind = el.type === "radio" ? "radio" : el.tagName.toLowerCase();
    return `${kind} "${label}"`;
  });
}

async function axe(page, label) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const summary = violations.map((v) => `${v.id}(${v.impact}, ${v.nodes.length})`).join(", ");
  record(`axe:${label}`, violations.length === 0, violations.length ? summary : "no violations");
  return violations;
}

const browser = await chromium.launch({ channel: "chrome" });
// axe-core/playwright requires an explicit context, not browser.newPage().
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(BASE);
await page.getByRole("list").first().waitFor();
await page.waitForTimeout(300);

// 1. Accessibility tree of the list — what a screen reader user actually hears.
const tree = await page.getByRole("list").first().ariaSnapshot();
console.log("\n--- accessibility tree: note list (active view) ---\n" + tree + "\n");
const archiveButtons = page.getByRole("button", { name: /архівувати/i });
const names = await archiveButtons.evaluateAll((els) =>
  els.map((e) => e.getAttribute("aria-label") || e.textContent.trim()),
);
record(
  "a11y:archive-button-names-unique",
  new Set(names).size === names.length && names.length > 0,
  `names: ${JSON.stringify(names)}`,
);

// 2. Target size (WCAG 2.5.8, 24×24 CSS px minimum).
const sizes = await page.getByRole("button").evaluateAll((els) =>
  els.map((e) => {
    const r = e.getBoundingClientRect();
    return { name: e.getAttribute("aria-label") || e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
  }),
);
const small = sizes.filter((s) => s.w < 24 || s.h < 24);
record("a11y:target-size>=24px", small.length === 0, small.length ? JSON.stringify(small) : `${sizes.length} buttons OK`);

await axe(page, "active-view");

// 3. Archive one note with a single click: it must leave the active list,
//    and keyboard focus must land somewhere sensible, not on <body>.
const before = await page.getByRole("listitem").count();
await archiveButtons.first().click();
await page.waitForTimeout(400);
const after = await page.getByRole("listitem").count();
record("flow:single-click-archives", after === before - 1, `active notes ${before} → ${after}`);
record("a11y:focus-after-archive", (await describeFocus(page)) !== "BODY", `focus: ${await describeFocus(page)}`);

// 4. Archive view shows the archived note with an "unarchive" control.
await (await viewControl(page, "Архів")).click();
await page.waitForTimeout(400);
const archivedTree = await page.getByRole("list").first().ariaSnapshot();
console.log("\n--- accessibility tree: note list (archive view) ---\n" + archivedTree + "\n");
const unarchive = page.getByRole("button", { name: /повернути/i });
record("flow:archive-view-lists-note", (await unarchive.count()) === 1, `unarchive buttons: ${await unarchive.count()}`);
// A new note always lands in the active list, so the "add" form has no
// business in the archive view. Checked by actual visibility, not by the
// `hidden` attribute: a CSS `display` rule silently overrides that attribute.
const formVisible = await page.locator("form").first().isVisible();
record("flow:add-form-hidden-in-archive", !formVisible, `add form visible in archive view: ${formVisible}`);
await axe(page, "archive-view");

// 5. Unarchive it again → archive view becomes empty and says so.
await unarchive.first().click();
await page.waitForTimeout(400);
const emptyText = await page.locator("#empty").evaluate((e) => ({
  visible: !e.hidden && getComputedStyle(e).display !== "none",
  text: e.textContent.trim(),
}));
record("flow:empty-archive-state", emptyText.visible && emptyText.text.length > 0, JSON.stringify(emptyText));
// The note vanished from the view. A sighted user sees it; a screen reader
// user only learns about it if some live region says so.
const announced = await liveRegionText(page);
record("a11y:change-announced", announced.length > 0, `live regions: ${JSON.stringify(announced)}`);
record("a11y:focus-after-last-unarchive", (await describeFocus(page)) !== "BODY", `focus: ${await describeFocus(page)}`);
await axe(page, "empty-archive-view");

// 6. Double click on "archive" — what an impatient user or a flaky network
//    retry does. Intent: archived once. Outcome must be: archived.
await (await viewControl(page, "Активні")).click();
await page.waitForTimeout(400);
const target = page.getByRole("button", { name: /архівувати/i }).first();
await target.dblclick();
await page.waitForTimeout(800);
await (await viewControl(page, "Архів")).click();
await page.waitForTimeout(400);
const archivedAfterDbl = await page.getByRole("button", { name: /повернути/i }).count();
record("flow:double-click-still-archived", archivedAfterDbl === 1, `archived notes after a double click: ${archivedAfterDbl}`);

// 7. Keyboard only: the view switch and the archive button are reachable.
await page.goto(BASE);
await page.waitForTimeout(300);
const tabStops = [];
for (let i = 0; i < 12; i++) {
  await page.keyboard.press("Tab");
  tabStops.push(await describeFocus(page));
}
record("kbd:view-switch-reachable-by-tab", tabStops.some((s) => /"(Активні|Архів)"/.test(s)), "");
record("kbd:archive-reachable-by-tab", tabStops.some((s) => /архівувати/i.test(s)), tabStops.join(" → "));

// 8. Failure paths, forced with request interception.
const net = await (await browser.newContext()).newPage();
await net.goto(BASE);
await net.getByRole("list").first().waitFor();
await net.waitForTimeout(300);

// 8a. Visible, associated labels on the form (not only placeholder/aria-label).
const labelled = await net.evaluate(() =>
  ["title", "body"].map((id) => {
    const label = document.querySelector(`label[for="${id}"]`);
    return !!label && label.offsetParent !== null && label.textContent.trim().length > 0;
  }),
);
record("a11y:form-fields-have-visible-labels", labelled.every(Boolean), JSON.stringify(labelled));

// 8b. Race: the active list answers slowly, the user switches to the archive
//     meanwhile. The slow response must not overwrite the newer view.
await net.route(/\/api\/notes\?archived=false$/, async (route) => {
  await new Promise((r) => setTimeout(r, 900));
  await route.continue();
});
await (await viewControl(net, "Архів")).click();
await (await viewControl(net, "Активні")).click(); // triggers the slow request
await (await viewControl(net, "Архів")).click(); // newer, fast request
await net.waitForTimeout(1500);
await net.unroute(/\/api\/notes\?archived=false$/);
const raceState = await net.evaluate(() => ({
  heading: document.querySelector("#list-heading")?.textContent,
  archiveButtons: [...document.querySelectorAll("#notes button")].filter((b) =>
    /^Архівувати/.test(b.textContent),
  ).length,
}));
record(
  "race:stale-list-does-not-win",
  raceState.heading === "Архів" && raceState.archiveButtons === 0,
  JSON.stringify(raceState),
);

// 8c. Network failure on the action: say so, give the button back, keep focus.
await (await viewControl(net, "Активні")).click();
await net.waitForTimeout(400);
await net.route(/\/api\/notes\/\d+$/, (route) =>
  route.request().method() === "PATCH" ? route.abort("failed") : route.continue(),
);
const firstArchive = net.getByRole("button", { name: /^Архівувати/ }).first();
const failedName = (await firstArchive.getAttribute("aria-label")) ?? (await firstArchive.textContent()).trim();
await firstArchive.click();
await net.waitForTimeout(500);
const afterAbort = {
  status: await liveRegionText(net),
  focus: await describeFocus(net),
  stillListed: await net.getByRole("button", { name: failedName }).count(),
  enabled: await net.getByRole("button", { name: failedName }).first().isEnabled(),
};
record(
  "net:action-failure-reported",
  /не вдалося/i.test(afterAbort.status) && afterAbort.stillListed === 1 && afterAbort.enabled && afterAbort.focus.includes(failedName),
  JSON.stringify(afterAbort),
);
await net.unroute(/\/api\/notes\/\d+$/);

// 8d. The action succeeds but the reload fails: never announce success over
//     the error, and leave the button usable.
await net.route(/\/api\/notes\?archived=/, (route) =>
  route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
);
await net.getByRole("button", { name: /^Архівувати/ }).first().click();
await net.waitForTimeout(600);
const afterReloadFail = await liveRegionText(net);
record(
  "net:no-success-over-reload-error",
  /не вдалося завантажити/i.test(afterReloadFail) && !/архівовано/.test(afterReloadFail),
  JSON.stringify(afterReloadFail),
);
await net.unroute(/\/api\/notes\?archived=/);

// 9. Dark scheme. The stylesheet declares `color-scheme: light dark`, so the
//    contrast requirement holds in both; axe above only saw the light one.
//    Both views: by now the earlier steps may have archived every note, and an
//    empty view would leave the note buttons out of the contrast check.
const dark = await (await browser.newContext({ colorScheme: "dark" })).newPage();
await dark.goto(BASE);
await dark.getByRole("list").first().waitFor({ state: "attached" });
await dark.waitForTimeout(300);
await axe(dark, "dark-scheme-active");
await (await viewControl(dark, "Архів")).click();
await dark.waitForTimeout(400);
const darkNoteButtons = await dark.locator("#notes button").count();
record("dark:note-buttons-present", darkNoteButtons > 0, `note buttons in the dark archive view: ${darkNoteButtons}`);
await axe(dark, "dark-scheme-archive");

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
