import { el } from "../dom";
import gradeA from "../../design/grade-avatars/grade-a.svg?url";
import gradeB from "../../design/grade-avatars/grade-b.svg?url";
import gradeC from "../../design/grade-avatars/grade-c.svg?url";
import gradePending from "../../design/grade-avatars/grade-pending.svg?url";
import gradeUngraded from "../../design/grade-avatars/grade-ungraded.svg?url";

let dateFormatter: Intl.DateTimeFormat | undefined;

export function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  dateFormatter ??= new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return dateFormatter.format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}

// Import the approved artwork directly so every view uses the same composition.
const gradeImages: Record<string, string> = {
  A: gradeA,
  B: gradeB,
  C: gradeC,
  P: gradePending,
  Z: gradePending,
};

/** Decorative inside an avatar or map button that already names the grade. */
export function gradeImage(grade: string | null): HTMLImageElement {
  return el("img", {
    class: "grade-image",
    src: gradeImages[grade || ""] || gradeUngraded,
    alt: "",
    "aria-hidden": true,
    width: 100,
    height: 100,
    draggable: "false",
  });
}
export const gradeLabel = (grade: string | null) =>
  grade === "P" || grade === "Z"
    ? "Grade pending"
    : grade
      ? `Grade ${grade}`
      : "No recorded grade";

export function gradeAvatar(
  grade: string | null,
  title?: string,
  large = false,
): HTMLElement {
  const label = gradeLabel(grade);
  const avatar = el(
    "figure",
    {
      "data-variant": "avatar",
      class: `grade-avatar${large ? " large" : ""}`,
      "aria-label": label,
      title: title || label,
    },
    gradeImage(grade),
  );
  return avatar;
}

export function watchCountBadge(codes: string[] = []) {
  const badge = el("span", {
    class: "badge grade-watch-count",
    "data-variant": "warning",
  });
  updateWatchCount(badge, codes);
  return badge;
}

export function updateWatchCount(badge: HTMLElement, codes: string[]) {
  badge.hidden = !codes.length;
  badge.textContent = String(codes.length);
  badge.setAttribute("aria-label", `${codes.length} watched violations`);
  badge.title = `Watched violations: ${codes.join(", ")}`;
}

export function restaurantMeta(cuisine: string, updated: Node | string) {
  return el(
    "span",
    { class: "restaurant-meta hstack gap-2 text-light" },
    el("span", {}, cuisine),
    el("span", { "aria-hidden": true }, "·"),
    typeof updated === "string" ? el("span", {}, updated) : updated,
  );
}

export function violationBadge(
  code: string,
  watched: boolean,
  onToggle?: (watched: boolean) => void,
) {
  return el(
    onToggle ? "button" : "span",
    {
      class: "badge violation-code",
      "data-variant": watched ? "warning" : "secondary",
      "aria-label": onToggle
        ? `Watch violation ${code}`
        : watched
          ? `${code}, watched`
          : code,
      type: onToggle ? "button" : undefined,
      "aria-pressed": onToggle ? watched : undefined,
      "data-watch-code": onToggle ? code : undefined,
      title: onToggle
        ? `${watched ? "Stop watching" : "Watch"} ${code}`
        : undefined,
      onclick: onToggle
        ? (event: MouseEvent) => {
            // Keep focus on this finding when its watch state reorders the list.
            (event.currentTarget as HTMLElement).focus({ preventScroll: true });
            onToggle(!watched);
          }
        : undefined,
    },
    code,
  );
}

export { icon } from "../icons";
