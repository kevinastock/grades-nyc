type Child = Node | string | number | null | undefined | false;

/** Build a DOM node without interpreting data as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (name.startsWith("on") && typeof value === "function") {
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (typeof value === "boolean" && !/^(aria-|data-)/.test(name)) {
      if (value) node.setAttribute(name, "");
    } else {
      node.setAttribute(name === "className" ? "class" : name, String(value));
    }
  }
  for (const child of children) {
    if (child != null && child !== false) {
      node.append(child instanceof Node ? child : String(child));
    }
  }
  // A select's value can only be selected after its options exist.
  if (attrs.value != null && "value" in node) {
    (node as HTMLInputElement).value = String(attrs.value);
  }
  return node;
}
