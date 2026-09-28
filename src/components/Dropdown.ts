import { el } from "../dom";
import { icon } from "../icons";

export type Choice = [value: string, label: string];
let nextId = 0;

/** Selection menus composed from Oat's dropdown, including its keyboard navigation. */
export function createDropdown({
  label,
  choices: initialChoices,
  value: initialValue = "",
  onChange,
}: {
  label: string;
  choices: Choice[];
  value?: string;
  onChange: (value: string) => void;
}) {
  let choices = initialChoices;
  let value = initialValue;
  let typeahead = "";
  let lastKey = 0;
  let tabTarget: HTMLElement | undefined;
  let outsideFocus: HTMLElement | undefined;
  const id = `choice-menu-${++nextId}`;
  const caption = el("span", { class: "dropdown-value", id: `${id}-value` });
  const trigger = el(
    "button",
    {
      type: "button",
      class: "outline",
      popovertarget: id,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": id,
      "aria-label": label,
      "aria-describedby": caption.id,
    },
    caption,
    icon("chevron-down"),
  );
  const menu = el("menu", {
    id,
    popover: "auto",
    role: "menu",
    class: "choice-menu",
    "aria-label": label,
  });
  const element = document.createElement("ot-dropdown");
  element.className = "choice-dropdown";
  element.append(trigger, menu);

  function update() {
    caption.textContent =
      choices.find(([key]) => key === value)?.[1] || choices[0]?.[1] || "";
    trigger.title = `${label}: ${caption.textContent}`;
    for (const item of menu.querySelectorAll<HTMLButtonElement>(
      "[data-value]",
    )) {
      const current = item.dataset.value === value;
      if (current) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
      item
        .querySelector(".choice-check")!
        .replaceChildren(...(current ? [icon("check")] : []));
    }
  }
  function setChoices(next: Choice[]) {
    if (menu.matches(":popover-open")) menu.hidePopover();
    choices = next;
    menu.replaceChildren(
      ...choices.map(([key, text]) =>
        el(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: "ghost",
            tabindex: -1,
            "data-value": key,
            onclick: () => {
              value = key;
              menu.hidePopover();
              update();
              onChange(key);
            },
          },
          el("span", { class: "choice-check", "aria-hidden": true }),
          text,
        ),
      ),
    );
    update();
  }
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menu.showPopover();
    }
  });
  // Oat owns arrow/Home/End navigation. Add type-to-jump for the long cuisine menu.
  menu.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        menu.hidePopover();
        trigger.focus();
      } else if (event.key === "Tab") {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button, input, [tabindex="0"]',
          ),
        ].filter(
          (item) =>
            !menu.contains(item) &&
            !item.matches(":disabled") &&
            item.getClientRects().length,
        );
        const index = controls.indexOf(trigger);
        tabTarget = controls[index + (event.shiftKey ? -1 : 1)];
        if (tabTarget) event.preventDefault();
        menu.hidePopover();
      } else if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key !== " "
      ) {
        const now = Date.now();
        typeahead =
          (now - lastKey < 650 ? typeahead : "") + event.key.toLowerCase();
        lastKey = now;
        const match = [
          ...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
        ].find((item) =>
          item.textContent?.trim().toLowerCase().startsWith(typeahead),
        );
        if (match) {
          event.preventDefault();
          match.focus();
        }
      }
    },
    true,
  );
  function focusOutsideMenu() {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      active !== document.body &&
      active !== trigger &&
      !menu.contains(active)
      ? active
      : undefined;
  }
  function fitMenu() {
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      menu.hidePopover();
      return;
    }
    // Oat flips above the trigger when necessary; let either side fit fully.
    menu.style.setProperty(
      "--menu-room",
      `${Math.max(0, rect.top - 8, window.innerHeight - rect.bottom - 8)}px`,
    );
  }
  function stopSizing() {
    window.removeEventListener("scroll", fitMenu, true);
    window.removeEventListener("resize", fitMenu);
  }
  menu.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState === "closed")
      outsideFocus = focusOutsideMenu();
  });
  menu.addEventListener("toggle", () => {
    if (menu.matches(":popover-open")) {
      typeahead = "";
      fitMenu();
      // Register before Oat's positioning listeners so it measures the new size.
      window.addEventListener("scroll", fitMenu, true);
      window.addEventListener("resize", fitMenu);
      // Oat focuses its first menu item; then prefer the currently selected one.
      queueMicrotask(() => {
        if (menu.matches(":popover-open"))
          menu.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
      });
    } else {
      stopSizing();
      // Light-dismiss can precede the clicked control receiving focus.
      const next = tabTarget || focusOutsideMenu() || outsideFocus;
      tabTarget = undefined;
      outsideFocus = undefined;
      // Oat returns focus to its trigger; keep click-away/Tab destinations intact.
      queueMicrotask(() => {
        if (next?.isConnected) next.focus();
      });
    }
  });
  setChoices(choices);
  return {
    element,
    trigger,
    get value() {
      return value;
    },
    set value(next: string) {
      value = next;
      update();
    },
    get disabled() {
      return trigger.disabled;
    },
    set disabled(next: boolean) {
      trigger.disabled = next;
    },
    setChoices,
    destroy() {
      stopSizing();
      element.remove();
    },
  };
}
