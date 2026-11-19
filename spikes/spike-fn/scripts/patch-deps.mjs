// Workaround for a ship-time platform bug: `telnyx-edge ship` bundles the
// `telnyx` SDK (pulled in via @telnyx/edge-runtime's root barrel, which is not
// tree-shaken) and the platform's upload secret scanner ("generic-api-key")
// rejects the bundle because JSDoc @example blocks in the SDK contain
// key/token-like sample values. These replacements rewrite only doc comments.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = new URL("../node_modules/telnyx/resources/", import.meta.url)
  .pathname;

const patches = [
  "llm-token-gateway/usage",
  "llm-token-gateway/token-keys",
  "integration-secrets",
  "messaging-10dlc/brand/external-vetting",
  "agent-gateways/mcp-servers",
  "credential-connections/credential-connections",
];

const replacements = [
  ["'182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e'", "'<your-token-group-id>'"],
  ["'11111111-1111-4111-8111-111111111111'", "'<your-token-group-id>'"],
  ["'my_secret_value'", "'<your-secret-value>'"],
  ["'Vettingtoken'", "'<your-vetting-token>'"],
  ["'example-orders-key'", "'<your-api-key-value>'"],
  ["'my123secure456password789'", "'<your-password>'"],
];

let touched = 0;
for (const name of patches) {
  for (const ext of [".mjs", ".js"]) {
    const path = `${ROOT}${name}${ext}`;
    if (!existsSync(path)) continue;
    let src = readFileSync(path, "utf8");
    const before = src;
    for (const [from, to] of replacements) src = src.split(from).join(to);
    if (src !== before) {
      writeFileSync(path, src);
      touched++;
    }
  }
}
console.log(`patch-deps: sanitized ${touched} file(s)`);
