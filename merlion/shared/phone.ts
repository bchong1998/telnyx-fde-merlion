// Phone normalisation + masking helpers (stateless plain function logic).
//
// normalisePhone: best-effort E.164. Default country is SG (+65): bare 8-digit
// numbers get +65. SIP URIs (web dialer, e.g. xxx@sip.telnyx.eu) and anything
// unparseable return null — callers then treat the party as unknown.

export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  if (s.includes("@") || /[a-zA-Z]/.test(s)) return null; // SIP URIs, garbage
  s = s.replace(/[\s().-]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 8) return "+65" + s; // SG national number
  if (s.length >= 9 && s.length <= 15) return "+" + s; // already carries a country code
  return null;
}

// "+6582925458" -> "+65****5458". Never log unmasked numbers (PDPA).
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164 || e164.length < 7) return null;
  return e164.slice(0, 3) + "****" + e164.slice(-4);
}
