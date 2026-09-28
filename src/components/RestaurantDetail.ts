import { getInspections } from "../data/client";
import { restaurantLinks, matchingCodes } from "../data/model.mjs";
import { toast } from "@knadh/oat/js/toast.js";
import {
  groupInspections,
  relativeDate,
  titleCase,
} from "../data/presentation.mjs";
import type { Inspection, Restaurant } from "../data/types";
import { el } from "../dom";
import {
  formatDate,
  gradeAvatar,
  violationBadge,
  icon,
  watchCountBadge,
  updateWatchCount,
  restaurantMeta,
} from "./shared";

export type RestaurantDetailProps = {
  restaurant: Restaurant;
  selected: string[];
  onWatchChange: (code: string, watched: boolean) => void;
  onClose: () => void;
};

export function createRestaurantDetail(
  host: HTMLElement,
  initial: RestaurantDetailProps,
) {
  let props = initial;
  let inspections: Inspection[] | null = null;
  let error = "";
  let reloadRequired = false;
  let request = 0;
  let destroyed = false;
  const openDates = new Set<string>();
  const warnings = watchCountBadge();
  const identity = el("header", { class: "detail-identity mb-2" });
  const timeline = el("div", { class: "inspection-list" });
  const article = el(
    "article",
    { class: "restaurant-detail" },
    identity,
    timeline,
  );
  host.replaceChildren(article);

  function renderIdentity() {
    const { restaurant } = props;
    const links = restaurantLinks(restaurant);
    const name = titleCase(restaurant.name);
    const external = { target: "_blank", rel: "noopener noreferrer" };
    const graded = restaurant.grade_date || restaurant.grade_inspected;
    article.setAttribute("aria-label", `${name} inspection details`);
    identity.replaceChildren(
      el(
        "div",
        { class: "detail-heading" },
        el(
          "a",
          {
            ...external,
            href: links.abcEats,
            "aria-label": `View official ABCEats record for ${name}`,
            class: "detail-grade-link grade-avatar-wrap unstyled",
          },
          gradeAvatar(restaurant.grade, "View official ABCEats record", true),
          warnings,
        ),
        el(
          "div",
          { class: "detail-identity-text vstack gap-1" },
          el(
            "div",
            { class: "detail-title" },
            el("h2", { tabindex: -1 }, name),
            el(
              "div",
              { class: "detail-actions hstack gap-1" },
              el(
                "a",
                {
                  ...external,
                  href: links.googleSearch,
                  class: "button ghost icon small",
                  "aria-label": `Search Google for ${name}`,
                  title: "Search Google",
                },
                icon("search"),
              ),
              el(
                "button",
                {
                  type: "button",
                  class: "detail-close ghost icon small",
                  "aria-label": "Close restaurant details",
                  title: "Close restaurant details",
                  onclick: () => props.onClose(),
                },
                icon("x"),
              ),
            ),
          ),
          el(
            "p",
            {},
            el(
              "a",
              {
                ...external,
                href: links.appleAddress,
                title: "Open address in Maps",
              },
              `${titleCase(restaurant.address) || "Address unavailable"}, ${titleCase(restaurant.borough)} ${restaurant.zip}`,
            ),
          ),
          restaurantMeta(
            titleCase(restaurant.cuisine),
            restaurant.grade
              ? el(
                  "time",
                  { datetime: graded, title: formatDate(graded) },
                  relativeDate(graded),
                )
              : restaurant.latest_date
                ? "No recorded grade"
                : "Not yet inspected",
          ),
        ),
      ),
    );
    updateWarnings();
    if (restaurant.closure === "uncertain") {
      identity.append(
        el(
          "div",
          { role: "alert", "data-variant": "warning" },
          `Closure and reopening recorded on ${formatDate(restaurant.closed_date)}; order unknown.`,
        ),
      );
    }
  }

  function updateWarnings() {
    updateWatchCount(
      warnings,
      matchingCodes(props.restaurant, props.selected, "latest"),
    );
  }

  function toggleWatch(code: string, watched: boolean) {
    props.onWatchChange(code, watched);
    toast(
      `${code} ${watched ? "added to" : "removed from"} watchlist`,
      undefined,
      {
        duration: 2000,
        placement: "bottom-center",
        variant: watched ? "success" : "info",
      },
    );
  }

  function renderInspections() {
    if (error) {
      timeline.replaceChildren(
        el(
          "div",
          { role: "alert", "data-variant": "error" },
          el("strong", {}, "Couldn’t load inspections"),
          el("p", {}, error),
          el(
            "button",
            {
              type: "button",
              class: "small",
              onclick: () =>
                reloadRequired ? window.location.reload() : void load(),
            },
            reloadRequired ? "Reload latest data" : "Retry",
          ),
        ),
      );
      return;
    }
    if (!inspections) {
      timeline.replaceChildren(
        el(
          "div",
          { class: "hstack", role: "status" },
          el("span", {
            "aria-busy": "true",
            "data-spinner": "small",
            "aria-hidden": "true",
          }),
          "Loading inspections…",
        ),
      );
      return;
    }
    const days = groupInspections(inspections, props.selected);
    if (!days.length) {
      timeline.replaceChildren(
        el("p", { class: "text-light" }, "No completed inspections."),
      );
      return;
    }
    const active = document.activeElement;
    const focusedCode =
      active instanceof HTMLElement && timeline.contains(active)
        ? active.dataset.watchCode
        : undefined;
    const focusedDate =
      active instanceof HTMLElement
        ? active.closest<HTMLElement>("[data-inspected]")?.dataset.inspected
        : undefined;
    const existingDates = [...timeline.querySelectorAll("details")];
    if (existingDates.length) {
      openDates.clear();
      for (const detail of existingDates) {
        if (detail.open) openDates.add(detail.dataset.inspected!);
      }
    }
    const selected = new Set(props.selected);
    timeline.replaceChildren(
      ...days.map((inspection) => {
        const findings = el(
          "div",
          { class: "inspection-findings" },
          ...inspection.actions.map((action) => el("p", {}, action)),
        );
        if (!inspection.findings.length) {
          findings.append(
            el("p", { class: "text-light" }, "No violations recorded."),
          );
        } else {
          findings.append(
            el(
              "ul",
              { class: "findings unstyled vstack gap-1" },
              ...inspection.findings.map((finding) => {
                const watched = selected.has(finding.code);
                return el(
                  "li",
                  { class: watched ? "watched-finding" : undefined },
                  el(
                    "div",
                    { class: "violation-row vstack gap-2" },
                    el(
                      "span",
                      { class: "hstack gap-2" },
                      violationBadge(finding.code, watched, (enabled) =>
                        toggleWatch(finding.code, enabled),
                      ),
                      finding.critical &&
                        el(
                          "span",
                          { class: "badge", "data-variant": "danger" },
                          "Critical",
                        ),
                    ),
                    el(
                      "span",
                      {},
                      finding.description || "Description unavailable.",
                    ),
                  ),
                );
              }),
            ),
          );
        }
        const detail = el(
          "details",
          {
            open: openDates.has(inspection.inspected),
            "data-inspected": inspection.inspected,
          },
          el(
            "summary",
            {},
            el(
              "span",
              { class: "hstack justify-between w-100" },
              el("strong", {}, formatDate(inspection.inspected)),
              inspection.score != null &&
                el(
                  "span",
                  { class: "text-light" },
                  `${inspection.score} points`,
                ),
            ),
          ),
          findings,
        );
        return detail;
      }),
    );
    if (focusedCode) {
      [...timeline.querySelectorAll<HTMLElement>("[data-watch-code]")]
        .find(
          (button) =>
            button.dataset.watchCode === focusedCode &&
            button.closest<HTMLElement>("[data-inspected]")?.dataset
              .inspected === focusedDate,
        )
        ?.focus({ preventScroll: true });
    }
  }

  async function load() {
    const currentRequest = ++request;
    inspections = null;
    error = "";
    reloadRequired = false;
    openDates.clear();
    renderInspections();
    try {
      const value = await getInspections(props.restaurant.id);
      if (destroyed || currentRequest !== request) return;
      inspections = value;
      const first = groupInspections(value)[0];
      if (first) openDates.add(first.inspected);
    } catch (reason) {
      if (destroyed || currentRequest !== request) return;
      error = reason instanceof Error ? reason.message : String(reason);
      reloadRequired = Boolean(
        reason &&
        typeof reason === "object" &&
        "code" in reason &&
        reason.code === "SNAPSHOT_EXPIRED",
      );
    }
    renderInspections();
  }

  renderIdentity();
  void load();
  return {
    update(next: RestaurantDetailProps) {
      const changedRestaurant = props.restaurant.id !== next.restaurant.id;
      const changedIdentity = props.restaurant !== next.restaurant;
      const changedSelection = props.selected !== next.selected;
      props = next;
      if (changedIdentity) renderIdentity();
      else if (changedSelection) updateWarnings();
      if (changedRestaurant) void load();
      else if (changedSelection) renderInspections();
    },
    destroy() {
      destroyed = true;
      request++;
      article.remove();
    },
  };
}
