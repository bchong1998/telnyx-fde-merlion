// Telnyx webhook signature verification (ed25519).
// Scheme (matches the telnyx SDK's lib/webhooks): signed message is
// `${telnyx-timestamp}|${raw body bytes}`; headers telnyx-signature-ed25519
// (base64, 64 bytes) and telnyx-timestamp (unix seconds) are required;
// timestamps more than 300 s away are rejected (replay window).
// Portable: hand-rolled base64 + WebCrypto, with a node:crypto fallback.

export class SigError extends Error {}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new SigError("invalid base64");
  }
  const pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = B64.indexOf(value[i]);
    const b = B64.indexOf(value[i + 1]);
    const c = value[i + 2] === "=" ? 0 : B64.indexOf(value[i + 2]);
    const d = value[i + 3] === "=" ? 0 : B64.indexOf(value[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new SigError("invalid base64");
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (chunk >> 16) & 0xff;
    if (o < out.length) out[o++] = (chunk >> 8) & 0xff;
    if (o < out.length) out[o++] = chunk & 0xff;
  }
  return out;
}

async function getSubtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Older Node-style runtimes expose WebCrypto here.
  const nodeCrypto = await import("node:crypto");
  return (nodeCrypto.webcrypto as unknown as Crypto).subtle;
}

// Cache the imported CryptoKey — it's constant per process.
let cachedKey: Promise<CryptoKey> | null = null;

function importKey(publicKeyB64: string): Promise<CryptoKey> {
  if (!cachedKey) {
    const bytes = decodeBase64(publicKeyB64);
    if (bytes.length !== 32) throw new SigError(`bad public key length ${bytes.length}`);
    cachedKey = getSubtle().then((s) =>
      s.importKey("raw", bytes as BufferSource, { name: "Ed25519" }, false, ["verify"]),
    );
    cachedKey.catch(() => (cachedKey = null)); // don't cache failures
  }
  return cachedKey;
}

/**
 * Returns "ok" when the signature is valid, "skipped" when devBypass is true.
 * Throws SigError with a human-readable reason otherwise.
 */
export async function verifyTelnyxSignature(
  rawBody: string,
  headers: Headers,
  publicKeyB64: string,
  devBypass = false,
): Promise<"ok" | "skipped"> {
  if (devBypass) return "skipped";

  const sigHeader = headers.get("telnyx-signature-ed25519");
  const tsHeader = headers.get("telnyx-timestamp");
  if (!sigHeader) throw new SigError("missing telnyx-signature-ed25519");
  if (!tsHeader) throw new SigError("missing telnyx-timestamp");
  if (!/^\d+$/.test(tsHeader)) throw new SigError("bad timestamp format");
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(tsHeader));
  if (skew > 300) throw new SigError(`timestamp outside 300s replay window (skew ${skew}s)`);

  const sig = decodeBase64(sigHeader);
  if (sig.length !== 64) throw new SigError(`bad signature length ${sig.length}`);

  const key = await importKey(publicKeyB64);
  const msg = new TextEncoder().encode(`${tsHeader}|${rawBody}`);
  const subtle = await getSubtle();
  const valid = await subtle.verify("Ed25519", key, sig as BufferSource, msg);
  if (!valid) throw new SigError("signature mismatch");
  return "ok";
}
