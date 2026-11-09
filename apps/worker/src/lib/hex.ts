/** Lowercase hex of a byte buffer (digests, MACs). */
export const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of a UTF-8 string, as hex. Used for cache keys. */
export const sha256Hex = async (text: string): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
