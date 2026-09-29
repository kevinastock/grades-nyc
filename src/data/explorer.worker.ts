import { createExplorer } from "./explorer.mjs";
import { validateManifest, validateSummary } from "./manifest.mjs";

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
      case "init-summary": {
        const manifest = validateManifest(args[1]);
        const bytes = args[0];
        if (
          !(bytes instanceof ArrayBuffer) ||
          bytes.byteLength !== manifest.summary.bytes
        )
          throw new Error("Inspection data is incomplete. Please try again.");
        let value;
        try {
          value = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new Error("Inspection data is invalid. Please try again.");
        }
        explorer = createExplorer(validateSummary(value, manifest).restaurants);
        // Only initial data loading needs columns back on the UI thread. Search
        // retries already have their UI data and keep the small ready response.
        if (args[2]) result = value;
        break;
      }
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
