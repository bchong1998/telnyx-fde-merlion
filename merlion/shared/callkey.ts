// Shared call-key validation (dogfooding #30).
//
// A "call key" binds /verify + MCP calls of one conversation (CustomerActor
// verified_call_id, CallContext customer memory). On web_chat the platform
// leaves template placeholders unresolved, so a literal "{{call_control_id}}"
// was previously accepted as a key — every chat session shared one auth slot.
// Fail-closed rule: a key must be non-empty, template-free, and bounded.

export function isValidCallKey(k: unknown): k is string {
  return (
    typeof k === "string" &&
    k.length > 0 &&
    k.length <= 128 &&
    !k.includes("{{") &&
    !k.includes("}}")
  );
}
