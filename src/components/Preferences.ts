import { el } from "../dom";
import { createDropdown } from "./Dropdown";
import { icon, violationBadge } from "./shared";
import type { Violation } from "../data/types";

export type PreferencesProps = {
  violations: Violation[];
  selected: string[];
  onChange: (codes: string[]) => void;
};

export function createPreferences(
  host: HTMLElement,
  initial: PreferencesProps,
) {
  let props = initial;
  const search = el("input", {
    type: "search",
    placeholder: "Search violations",
    "aria-label": "Search violation types",
    oninput: () => renderCatalog(),
  });
  const sort = createDropdown({
    label: "Sort violation codes",
    value: "occurrences",
    choices: [
      ["occurrences", "Most common"],
      ["code", "Code order"],
    ],
    onChange: () => renderCatalog(),
  });
  const onlySelected = el("input", {
    type: "checkbox",
    role: "switch",
    "aria-label": "Selected only",
    onchange: () => renderCatalog(),
  });
  const clear = el(
    "button",
    {
      type: "button",
      class: "ghost icon small",
      "aria-label": "Clear watchlist",
      title: "Clear watchlist",
      onclick: () => {
        if (!props.selected.length || clearDialog.open) return;
        clearDialog.showModal();
        cancelClear.focus({ preventScroll: true });
      },
    },
    icon("rotate-ccw"),
  );
  const cancelClear = el(
    "button",
    {
      type: "button",
      class: "outline",
      autofocus: true,
      onclick: () => clearDialog.close(),
    },
    "Cancel",
  );
  const clearDialog = el(
    "dialog",
    {
      "aria-labelledby": "clear-watchlist-title",
      "aria-describedby": "clear-watchlist-description",
      onclose: () => {
        if (section.isConnected) {
          (clear.disabled ? search : clear).focus({ preventScroll: true });
        }
      },
    },
    el(
      "header",
      {},
      el(
        "h2",
        { id: "clear-watchlist-title" },
        "Clear all watched violations?",
      ),
    ),
    el(
      "p",
      { id: "clear-watchlist-description" },
      "This will remove all violations from your watchlist. You can add them again later.",
    ),
    el(
      "footer",
      {},
      cancelClear,
      el(
        "button",
        {
          type: "button",
          "data-variant": "danger",
          onclick: () => {
            if (!clearDialog.open) return;
            props.onChange([]);
            clearDialog.close();
          },
        },
        "Clear watchlist",
      ),
    ),
  );
  const meta = el("p", {
    class: "preferences-meta hstack justify-between text-light",
    role: "status",
  });
  const catalog = el("ul", {
    class: "violation-catalog unstyled vstack gap-2",
  });
  const empty = el("p", { class: "text-light" });
  const section = el(
    "section",
    { class: "preferences", "aria-label": "Violation watchlist" },
    el(
      "div",
      { class: "preferences-toolbar hstack gap-2" },
      search,
      sort.element,
      el(
        "label",
        { title: "Show selected violations only" },
        onlySelected,
        "Selected",
      ),
      clear,
    ),
    meta,
    catalog,
    empty,
    clearDialog,
  );
  host.replaceChildren(section);

  function renderCatalog() {
    const query = search.value.trim().toLowerCase();
    const watched = new Set(props.selected);
    const shown = props.violations
      .filter(
        (violation) =>
          (!onlySelected.checked || watched.has(violation.code)) &&
          `${violation.code} ${violation.description}`
            .toLowerCase()
            .includes(query),
      )
      .sort(
        (a, b) =>
          (sort.value === "occurrences" ? b.occurrences - a.occurrences : 0) ||
          a.code.localeCompare(b.code),
      );
    const active = document.activeElement;
    const focusedCode =
      active instanceof HTMLInputElement && catalog.contains(active)
        ? active.dataset.code
        : undefined;
    const previouslyFocusedIndex = [
      ...catalog.querySelectorAll("input"),
    ].indexOf(active as HTMLInputElement);
    meta.replaceChildren(
      el(
        "span",
        {},
        `${shown.length}${shown.length !== props.violations.length ? ` of ${props.violations.length}` : ""} codes`,
      ),
      el("span", {}, `${props.selected.length} selected`),
    );
    clear.disabled = !props.selected.length;
    catalog.replaceChildren(
      ...shown.map((violation) => {
        const checkbox = el("input", {
          type: "checkbox",
          role: "switch",
          checked: watched.has(violation.code),
          "data-code": violation.code,
          "aria-label": `Watch violation ${violation.code}`,
          onchange: () =>
            props.onChange(
              checkbox.checked
                ? [...props.selected, violation.code]
                : props.selected.filter((value) => value !== violation.code),
            ),
        });
        return el(
          "li",
          {},
          el(
            "label",
            { class: "card violation-option w-100" },
            checkbox,
            el(
              "span",
              { class: "vstack gap-2" },
              el(
                "span",
                { class: "hstack gap-2" },
                violationBadge(violation.code, watched.has(violation.code)),
                el(
                  "small",
                  {
                    class: "text-light",
                    title:
                      "Restaurants with this violation across all inspections",
                  },
                  `${violation.occurrences.toLocaleString("en-US")} ${violation.occurrences === 1 ? "restaurant" : "restaurants"}`,
                ),
                violation.critical_varies
                  ? el(
                      "span",
                      { class: "badge", "data-variant": "secondary" },
                      "Classification varies",
                    )
                  : violation.critical &&
                      el(
                        "span",
                        { class: "badge", "data-variant": "danger" },
                        "Critical",
                      ),
              ),
              el(
                "span",
                {},
                violation.description || "No description provided",
              ),
            ),
          ),
        );
      }),
    );
    empty.hidden = Boolean(shown.length);
    empty.textContent =
      onlySelected.checked && !props.selected.length
        ? "No watched violations."
        : "No matching violations.";
    if (focusedCode) {
      const inputs = [...catalog.querySelectorAll("input")];
      (
        inputs.find((input) => input.dataset.code === focusedCode) ||
        inputs[Math.min(previouslyFocusedIndex, inputs.length - 1)] ||
        search
      ).focus({ preventScroll: true });
    }
  }

  renderCatalog();
  return {
    update(next: PreferencesProps) {
      props = next;
      renderCatalog();
    },
    destroy() {
      sort.destroy();
      section.remove();
    },
  };
}
