import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// Bundle the real components while making only their data request controllable.
const compiled = await build({
  stdin: {
    contents: `
      export { createPreferences } from "./src/components/Preferences.ts";
      export { createRestaurantDetail } from "./src/components/RestaurantDetail.ts";
      export { createDropdown } from "./src/components/Dropdown.ts";
      export { gradeAvatar, gradeImage } from "./src/components/shared.ts";
      export { requests } from "test-inspections";
      export { notifications } from "@knadh/oat/js/toast.js";
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  loader: { ".svg": "text" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  plugins: [
    {
      name: "inspection-requests",
      setup(builder) {
        builder.onLoad({ filter: /\.svg$/ }, async (args) =>
          args.suffix === "?url"
            ? { contents: await readFile(args.path), loader: "dataurl" }
            : undefined,
        );
        builder.onResolve({ filter: /^@knadh\/oat\/js\/toast\.js$/ }, () => ({
          path: "toast",
          namespace: "toast-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "toast-test" }, () => ({
          contents: `
          export const notifications = [];
          export function toast(message, title, options) {
            notifications.push({ message, title, options });
            return document.createElement("output");
          }
        `,
        }));
        builder.onResolve(
          { filter: /^(test-inspections|\.\.\/data\/client)$/ },
          () => ({
            path: "inspections",
            namespace: "test",
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: `
          export const requests = [];
          export function getInspections(id) {
            return new Promise((resolve, reject) => requests.push({ id, resolve, reject }));
          }
        `,
        }));
      },
    },
  ],
});
const {
  createPreferences,
  createRestaurantDetail,
  createDropdown,
  gradeAvatar,
  gradeImage,
  requests,
  notifications,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const oat = await build({
  entryPoints: [
    fileURLToPath(
      new URL("../node_modules/@knadh/oat/js/dropdown.js", import.meta.url),
    ),
  ],
  bundle: true,
  write: false,
  format: "iife",
});

let browser, host;
beforeEach(() => {
  browser = new Window({ url: "https://example.test/nyc-grades/" });
  for (const key of [
    "window",
    "document",
    "Node",
    "HTMLElement",
    "HTMLInputElement",
  ]) {
    globalThis[key] = key === "window" ? browser : browser[key];
  }
  host = document.createElement("main");
  document.body.append(host);
  browser.eval(oat.outputFiles[0].text);
  requests.length = 0;
  notifications.length = 0;
});
afterEach(async () => {
  await browser.happyDOM.close();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
function change(input, value, type = "change") {
  if (typeof value === "boolean") input.checked = value;
  else input.value = value;
  input.dispatchEvent(new browser.Event(type, { bubbles: true }));
}
const codes = () =>
  [...host.querySelectorAll(".violation-catalog .violation-code")].map(
    (node) => node.textContent,
  );
const hostileText = '<img src=x onerror="alert(1)"> Dirty surfaces';
const violations = [
  {
    code: "02B",
    description: hostileText,
    critical: false,
    critical_varies: false,
    occurrences: 50,
  },
  {
    code: "03C",
    description: "Rodent activity",
    critical: null,
    critical_varies: true,
    occurrences: 90,
  },
  {
    code: "01A",
    description: "Unsafe food",
    critical: true,
    critical_varies: false,
    occurrences: 50,
  },
];

test("watchlist sorts and filters real descriptions without interpreting them as HTML", () => {
  const view = createPreferences(host, {
    violations,
    selected: [],
    onChange() {},
  });
  assert.deepEqual(codes(), ["03C", "01A", "02B"]);
  const sortMenu = host.querySelector("ot-dropdown menu");
  sortMenu.hidePopover = () => {};
  sortMenu.querySelector('[data-value="code"]').click();
  assert.deepEqual(codes(), ["01A", "02B", "03C"]);
  const search = host.querySelector('[type="search"]');
  search.focus();
  change(search, "  dIrTy  ", "input");
  assert.deepEqual(codes(), ["02B"]);
  assert.equal(document.activeElement, search);
  assert.ok(host.textContent.includes(hostileText));
  assert.equal(host.querySelector("img"), null);
  assert.match(
    host.querySelector('[role="status"]').textContent,
    /1 of 3 codes/,
  );
  change(search, "no matching text", "input");
  assert.deepEqual(codes(), []);
  assert.ok(
    [...host.querySelectorAll("p")].some(
      (node) => !node.hidden && node.textContent === "No matching violations.",
    ),
  );
  view.destroy();
  assert.equal(host.childElementCount, 0);
});

test("watchlist updates keep filters and keyboard focus when selections disappear", () => {
  let props = {
    violations,
    selected: ["01A", "02B"],
    onChange(selected) {
      props = { ...props, selected };
      view.update(props);
    },
  };
  const view = createPreferences(host, props);
  const selectedOnly = host.querySelector(
    'input[type="checkbox"]:not([data-code])',
  );
  change(selectedOnly, true);
  assert.deepEqual(codes(), ["01A", "02B"]);
  const first = host.querySelector('[data-code="01A"]');
  first.focus();
  change(first, false);
  assert.deepEqual(props.selected, ["02B"]);
  assert.deepEqual(codes(), ["02B"]);
  assert.equal(document.activeElement.dataset.code, "02B");
  assert.equal(selectedOnly.checked, true);
  change(document.activeElement, false);
  assert.deepEqual(codes(), []);
  assert.equal(document.activeElement, host.querySelector('[type="search"]'));
  assert.ok(
    [...host.querySelectorAll("p")].some(
      (node) => !node.hidden && node.textContent === "No watched violations.",
    ),
  );
  const clear = host.querySelector('[aria-label="Clear watchlist"]');
  assert.equal(clear.disabled, true);
  props = { ...props, selected: ["03C"] };
  view.update(props);
  clear.click();
  assert.deepEqual(props.selected, ["03C"]);
  assert.equal(host.querySelector("dialog").open, true);
  host.querySelector('dialog [data-variant="danger"]').click();
  assert.deepEqual(props.selected, []);
  assert.equal(host.querySelector("dialog").open, false);
  assert.equal(document.activeElement, host.querySelector('[type="search"]'));
  view.destroy();
});

test("clearing watched violations requires confirmation and Cancel keeps every selection", () => {
  let changes = 0;
  let props = {
    violations,
    selected: ["01A", "02B"],
    onChange(selected) {
      changes++;
      props = { ...props, selected };
      view.update(props);
    },
  };
  const view = createPreferences(host, props);
  const clear = host.querySelector('[aria-label="Clear watchlist"]');
  const dialog = host.querySelector("dialog");
  const cancel = dialog.querySelector("button");
  const confirm = dialog.querySelector('[data-variant="danger"]');
  clear.click();
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, cancel);
  assert.deepEqual(props.selected, ["01A", "02B"]);
  assert.equal(changes, 0);
  assert.equal(
    document.getElementById(dialog.getAttribute("aria-labelledby")).textContent,
    "Clear all watched violations?",
  );
  cancel.click();
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, clear);
  assert.deepEqual(props.selected, ["01A", "02B"]);
  assert.equal(changes, 0);
  clear.click();
  confirm.click();
  assert.equal(dialog.open, false);
  assert.deepEqual(props.selected, []);
  assert.equal(changes, 1);
  assert.equal(clear.disabled, true);
  confirm.click();
  clear.click();
  assert.equal(dialog.open, false);
  assert.equal(changes, 1);
  view.destroy();
  assert.equal(host.querySelector("dialog"), null);
});

function restaurant(id) {
  return {
    id,
    name: `Restaurant ${id}`,
    borough: "MANHATTAN",
    address: "1 MAIN ST",
    zip: "10001",
    cuisine: "AMERICAN",
    lat: 40.7,
    lon: -74,
    grade: "A",
    grade_date: "2026-08-15",
    grade_inspected: "2026-08-15",
    latest_date: "2026-08-15",
    latest_codes: "01A",
    closure: "none",
    closed_date: null,
  };
}
function inspection(inspected, code, description = "Recorded finding") {
  return {
    inspected,
    inspection_type: "Cycle Inspection",
    action: "Violations were cited",
    grade: "A",
    grade_date: inspected,
    score: 10,
    score_variants: 1,
    findings: [{ code, description, critical: false }],
  };
}

test("detail ignores old restaurant requests and results arriving after destruction", async () => {
  const props = {
    restaurant: restaurant("A"),
    selected: [],
    onWatchChange() {},
  };
  const view = createRestaurantDetail(host, props);
  assert.match(host.textContent, /Loading inspections/);
  view.update({ ...props, restaurant: restaurant("B") });
  assert.deepEqual(
    requests.map((request) => request.id),
    ["A", "B"],
  );
  requests[1].resolve([
    inspection("2026-08-15", "02B", "Current restaurant finding"),
  ]);
  await flush();
  requests[0].resolve([
    inspection("2026-06-01", "01A", "Stale restaurant finding"),
  ]);
  await flush();
  assert.match(host.textContent, /Current restaurant finding/);
  assert.doesNotMatch(host.textContent, /Stale restaurant finding/);
  assert.equal(host.querySelector("h2").textContent, "Restaurant B");
  view.update({ ...props, restaurant: restaurant("C") });
  view.destroy();
  requests[2].resolve([inspection("2026-07-01", "03C")]);
  await flush();
  assert.equal(host.childElementCount, 0);
});

test("watching a finding preserves expanded dates and focus when findings reorder", async () => {
  let props = {
    restaurant: restaurant("A"),
    selected: [],
    onWatchChange(code, enabled) {
      props = {
        ...props,
        selected: enabled
          ? [...props.selected, code]
          : props.selected.filter((value) => value !== code),
      };
      view.update(props);
    },
  };
  const view = createRestaurantDetail(host, props);
  requests[0].resolve([
    inspection("2026-08-15", "03C"),
    inspection("2026-07-10", "01A"),
    inspection("2026-07-10", "02B", hostileText),
  ]);
  await flush();
  const dates = [...host.querySelectorAll("details")];
  assert.equal(dates.length, 2, "same-day records form one inspection");
  assert.deepEqual(
    dates.map((date) => date.open),
    [true, false],
  );
  dates[0].open = false;
  dates[1].open = true;
  const trigger = host.querySelector('[data-watch-code="02B"]');
  trigger.click();
  assert.equal(host.querySelector('[role="switch"]'), null);
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");
  assert.equal(notifications.at(-1).message, "02B added to watchlist");
  assert.deepEqual(
    [...host.querySelectorAll("details")].map((date) => date.open),
    [false, true],
  );
  assert.deepEqual(
    [...host.querySelectorAll("details[open] .violation-code")].map(
      (code) => code.textContent,
    ),
    ["02B", "01A"],
  );
  assert.equal(document.activeElement.dataset.watchCode, "02B");
  assert.equal(
    document.activeElement.closest("details").dataset.inspected,
    "2026-07-10",
  );
  assert.ok(
    document.activeElement.closest("li").classList.contains("watched-finding"),
  );
  assert.ok(host.textContent.includes(hostileText));
  assert.equal(host.querySelector(".inspection-list img"), null);
  view.destroy();
});

test("violation badges toggle directly, announce changes, and keep avatar counts scoped to latest findings", async () => {
  let props = {
    restaurant: restaurant("A"),
    selected: [],
    onWatchChange(code, enabled) {
      props = {
        ...props,
        selected: enabled
          ? [...props.selected, code]
          : props.selected.filter((value) => value !== code),
      };
      view.update(props);
    },
    onClose() {},
  };
  const view = createRestaurantDetail(host, props);
  requests[0].resolve([
    inspection("2026-08-15", "01A"),
    inspection("2026-07-10", "02B"),
  ]);
  await flush();
  const count = host.querySelector(".detail-grade-link .grade-watch-count");
  assert.equal(count.hidden, true);
  const description = host.querySelector(
    "details[open] .violation-row > span:last-child",
  );
  description.click();
  assert.equal(
    notifications.length,
    0,
    "only the code badge changes watch state",
  );
  host.querySelector('[data-watch-code="01A"]').click();
  assert.deepEqual(props.selected, ["01A"]);
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, "1");
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "true");
  assert.equal(document.activeElement.dataset.variant, "warning");
  assert.equal(notifications.at(-1).message, "01A added to watchlist");
  assert.equal(notifications.at(-1).options.duration, 2000);
  host.querySelector('[data-watch-code="01A"]').click();
  assert.deepEqual(props.selected, []);
  assert.equal(count.hidden, true);
  assert.equal(document.activeElement.getAttribute("aria-pressed"), "false");
  assert.equal(notifications.at(-1).message, "01A removed from watchlist");
  const historical = host.querySelectorAll("details")[1];
  historical.open = true;
  historical.querySelector('[data-watch-code="02B"]').click();
  assert.deepEqual(props.selected, ["02B"]);
  assert.equal(
    count.hidden,
    true,
    "historical findings do not add current warnings",
  );
  view.destroy();
});

test("Oat selection menus update the current choice and support type-to-jump", () => {
  const changes = [];
  const choice = createDropdown({
    label: "Cuisine",
    choices: [
      ["", "All cuisines"],
      ["pizza", "Pizza"],
      ["thai", "Thai"],
    ],
    onChange: (value) => changes.push(value),
  });
  host.append(choice.element);
  const menu = choice.element.querySelector("menu");
  menu.hidePopover = () => {};
  assert.equal(choice.element.tagName, "OT-DROPDOWN");
  assert.equal(choice.trigger.getAttribute("popovertarget"), menu.id);
  assert.equal(host.querySelector("select"), null);
  menu.querySelector('[data-value="pizza"]').click();
  assert.deepEqual(changes, ["pizza"]);
  assert.equal(choice.value, "pizza");
  assert.equal(choice.trigger.textContent, "Pizza");
  assert.equal(
    menu.querySelector('[aria-current="true"]').dataset.value,
    "pizza",
  );
  menu.dispatchEvent(
    new browser.KeyboardEvent("keydown", {
      key: "t",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(document.activeElement.dataset.value, "thai");
  choice.value = "thai";
  assert.equal(choice.trigger.textContent, "Thai");
  choice.disabled = true;
  assert.equal(choice.trigger.disabled, true);
});

test("Oat dropdown navigation fits short screens and closing preserves newly focused details", async () => {
  const choice = createDropdown({
    label: "Cuisine",
    value: "pizza",
    choices: [
      ["", "All cuisines"],
      ["pizza", "Pizza"],
      ["thai", "Thai"],
    ],
    onChange() {},
  });
  host.append(choice.element);
  document.dispatchEvent(new browser.Event("DOMContentLoaded"));
  const menu = choice.element.querySelector("menu");
  let open = false;
  const matches = menu.matches.bind(menu);
  menu.matches = (selector) =>
    selector === ":popover-open" ? open : matches(selector);
  const toggleEvent = (type, newState) =>
    Object.assign(new browser.Event(type), { newState });
  menu.showPopover = () => {
    menu.dispatchEvent(toggleEvent("beforetoggle", "open"));
    open = true;
    menu.dispatchEvent(toggleEvent("toggle", "open"));
  };
  menu.hidePopover = () => {
    menu.dispatchEvent(toggleEvent("beforetoggle", "closed"));
    open = false;
    menu.dispatchEvent(toggleEvent("toggle", "closed"));
  };
  browser.innerHeight = 320;
  choice.trigger.getBoundingClientRect = () => ({
    top: 140,
    bottom: 180,
    left: 10,
    right: 150,
  });
  menu.showPopover();
  await flush();
  assert.equal(menu.style.getPropertyValue("--menu-room"), "132px");
  assert.equal(document.activeElement.dataset.value, "pizza");
  document.activeElement.dispatchEvent(
    new browser.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(document.activeElement.dataset.value, "thai");
  document.activeElement.dispatchEvent(
    new browser.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(document.activeElement.dataset.value, "thai");
  assert.equal(choice.trigger.ariaExpanded, "true");
  browser.innerHeight = 500;
  browser.dispatchEvent(new browser.Event("resize"));
  assert.equal(menu.style.getPropertyValue("--menu-room"), "312px");
  const card = document.createElement("button");
  const heading = document.createElement("h2");
  heading.tabIndex = -1;
  host.append(card, heading);
  card.focus();
  menu.dispatchEvent(toggleEvent("beforetoggle", "closed"));
  heading.focus();
  open = false;
  menu.dispatchEvent(toggleEvent("toggle", "closed"));
  await flush();
  assert.equal(document.activeElement, heading);
  assert.equal(choice.trigger.ariaExpanded, "false");
  browser.innerHeight = 700;
  browser.dispatchEvent(new browser.Event("resize"));
  assert.equal(
    menu.style.getPropertyValue("--menu-room"),
    "312px",
    "closed menus release sizing listeners",
  );
  choice.destroy();
});

test("grade avatars retain approved SVG artwork and accessible grade labels", async () => {
  for (const [grade, filename, label] of [
    ["A", "grade-a.svg", "Grade A"],
    ["B", "grade-b.svg", "Grade B"],
    ["C", "grade-c.svg", "Grade C"],
    ["P", "grade-pending.svg", "Grade pending"],
    ["Z", "grade-pending.svg", "Grade pending"],
    [null, "grade-ungraded.svg", "No recorded grade"],
  ]) {
    const avatar = gradeAvatar(grade);
    assert.equal(avatar.tagName, "FIGURE");
    assert.equal(avatar.dataset.variant, "avatar");
    assert.equal(avatar.getAttribute("aria-label"), label);
    assert.equal(avatar.title, label);
    assert.equal(avatar.classList.contains("large"), false);
    const image = avatar.querySelector("img");
    assert.ok(image, `${label} uses an SVG image`);
    assert.equal(image.alt, "");
    assert.equal(image.getAttribute("aria-hidden"), "true");
    assert.equal(image.getAttribute("draggable"), "false");
    assert.equal(image.width, 100);
    assert.equal(image.height, 100);
    const separator = image.src.indexOf(",");
    const metadata = image.src.slice(0, separator);
    assert.match(metadata, /^data:image\/svg\+xml(?:;base64)?$/);
    const encoded = image.src.slice(separator + 1);
    const artwork = metadata.endsWith(";base64")
      ? Buffer.from(encoded, "base64").toString("utf8")
      : decodeURIComponent(encoded);
    assert.equal(
      artwork,
      await readFile(
        new URL(`../design/grade-avatars/${filename}`, import.meta.url),
        "utf8",
      ),
      `${label} preserves the approved artwork without altering placement`,
    );
    const markerImage = gradeImage(grade);
    assert.equal(markerImage.src, image.src);
    assert.equal(markerImage.alt, "");
    assert.equal(markerImage.getAttribute("aria-hidden"), "true");
    host.append(avatar, gradeAvatar(grade));
  }
  assert.equal(host.querySelectorAll("img").length, 12);
  assert.equal(
    host.querySelector("svg, [id]"),
    null,
    "repeated avatars do not inject shared SVG title or description IDs",
  );
});

test("large grade avatars preserve their grade label and custom link title", () => {
  const avatar = gradeAvatar("C", "View official ABCEats record", true);
  assert.equal(avatar.classList.contains("large"), true);
  assert.equal(avatar.getAttribute("aria-label"), "Grade C");
  assert.equal(avatar.title, "View official ABCEats record");
  assert.equal(avatar.querySelector("img").src, gradeImage("C").src);
});

test("inspection failures offer retry, while expired snapshots reload the dataset", async () => {
  const props = {
    restaurant: restaurant("A"),
    selected: [],
    onWatchChange() {},
  };
  const view = createRestaurantDetail(host, props);
  requests[0].reject(new Error("Offline"));
  await flush();
  assert.match(host.querySelector('[role="alert"]').textContent, /Offline/);
  const retry = host.querySelector(".inspection-list button");
  assert.equal(retry.textContent, "Retry");
  retry.click();
  assert.equal(requests.length, 2);
  assert.match(host.textContent, /Loading inspections/);
  requests[1].resolve([]);
  await flush();
  assert.match(host.textContent, /No completed inspections/);
  view.update({ ...props, restaurant: restaurant("B") });
  requests[2].reject(
    Object.assign(new Error("Snapshot expired"), { code: "SNAPSHOT_EXPIRED" }),
  );
  await flush();
  const reload = host.querySelector(".inspection-list button");
  assert.equal(reload.textContent, "Reload latest data");
  let reloads = 0;
  browser.location.reload = () => reloads++;
  reload.click();
  assert.equal(reloads, 1);
  assert.equal(
    requests.length,
    3,
    "expired shards are not retried against the old snapshot",
  );
  view.destroy();
});
