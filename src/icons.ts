import x from "./icons/feather/x.svg?raw";
import rotateCcw from "./icons/feather/rotate-ccw.svg?raw";
import search from "./icons/feather/search.svg?raw";
import chevronDown from "./icons/feather/chevron-down.svg?raw";
import check from "./icons/feather/check.svg?raw";
import maximize from "./icons/feather/maximize.svg?raw";
import github from "./icons/feather/github.svg?raw";
import plus from "./icons/feather/plus.svg?raw";
import minus from "./icons/feather/minus.svg?raw";

// Explicit imports keep the shipped set small; no Feather runtime is needed.
const icons = {
  x,
  "rotate-ccw": rotateCcw,
  search,
  "chevron-down": chevronDown,
  check,
  maximize,
  github,
  plus,
  minus,
};

export function icon(name: keyof typeof icons): SVGSVGElement {
  const template = document.createElement("template");
  // Only these checked-in SVG assets are parsed, never application data.
  template.innerHTML = icons[name];
  const svg = template.content.firstElementChild as SVGSVGElement;
  svg.setAttribute("class", `feather feather-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}
