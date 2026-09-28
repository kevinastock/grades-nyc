import { createExplorer } from "./explorer.mjs";

let explorer: ReturnType<typeof createExplorer>;
const scope = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (value: unknown) => void;
};
scope.onmessage = ({ data: { id, type, args } }) => {
  try {
    let result;
    switch (type) {
      case "init":
        explorer = createExplorer(args[0]);
        break;
      case "query":
        result = explorer.query(args[0], args[1]);
        break;
      case "viewport":
        result = explorer.viewport(args[0], args[1], args[2]);
        break;
      case "expand":
        result = explorer.expand(args[0], args[1]);
        break;
      default:
        throw new Error("Unknown restaurant search request.");
    }
    scope.postMessage({ id, result });
  } catch (error) {
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
