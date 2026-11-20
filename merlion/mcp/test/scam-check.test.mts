// Unit tests for scam-indicator normalisation + fuzzy matching (#35).
//   node test/scam-check.test.mts

import assert from "node:assert/strict";
import { deSpoken, registrable, editDistance, computeVerdict } from "../src/index.ts";

// deSpoken: spoken separators become characters
assert.equal(deSpoken("million dash secure dash verify dot com"), "million-secure-verify.com");
assert.equal(deSpoken("dbs dash secure dash refund dot com"), "dbs-secure-refund.com");
assert.equal(deSpoken("HTTPS dbs dash secure dash refund dot top"), "httpsdbs-secure-refund.top");
assert.equal(registrable("login.dbs-secure-refund.top"), "dbs-secure-refund.top");
assert.equal(registrable("merlion-secure-verify.com"), "merlion-secure-verify.com");
assert.equal(editDistance("million-secure-verify.com", "merlion-secure-verify.com"), 2);
assert.equal(editDistance("parcel-redelivery-8492.xyz", "parcel-redelivery-8492.xyz"), 0);
assert.equal(editDistance("totally-unrelated.com", "merlion-secure-verify.com") > 2, true);

// the exact round-3 input that previously got "not in watchlist" (#35)
const r3 = computeVerdict("url", deSpoken("million dash secure dash verify dot com").replace(/^[a-z][a-z0-9+.-]*:\/\//, ""));
assert.equal(r3.match, "fuzzy");
assert.equal(r3.matched_value, "merlion-secure-verify.com");
assert.equal(r3.verdict, "known_scam");

// exact hits still exact; subdomains of feed entries still count as exact
assert.equal(computeVerdict("url", "merlion-secure-verify.com").match, "exact");
assert.equal(computeVerdict("url", "login.dbs-secure-refund.top").match, "exact");

// distant domains stay no_record, match none
const far = computeVerdict("url", "totally-unrelated.com");
assert.equal(far.match, "none");
assert.equal(far.verdict, "no_record");

// phone unaffected; sms_text heuristics unaffected by deSpoken
assert.equal(computeVerdict("phone", "+6580001001").match, "exact");
console.log("PASS  scam normalisation: round-3 'million dash secure dash verify dot com' → fuzzy known scam; exact/subdomain/no_record intact");
