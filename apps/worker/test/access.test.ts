import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { verifyAccessJwt } from "../src/lib/auth";

// Cloudflare Access signs RS256 JWTs whose issuer is the team domain and whose audience is the app's AUD tag.
const ISSUER = "https://riverbend.cloudflareaccess.com";
const AUD = "aud-tag-for-shortstop";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string | number } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  return { keys, sign };
}

describe("Cloudflare Access JWT verification", () => {
  it("accepts a valid token and returns its email, lower-cased", async () => {
    const { keys, sign } = await setup();
    const token = await sign({ email: "Priya.Raman@Riverbend.example" });
    expect(await verifyAccessJwt(token, { issuer: ISSUER, audience: AUD, keys })).toBe("priya.raman@riverbend.example");
  });

  it("rejects the wrong audience, the wrong issuer, an expired token and a forged signature", async () => {
    const { keys, sign } = await setup();
    const opts = { issuer: ISSUER, audience: AUD, keys };
    await expect(verifyAccessJwt(await sign({ email: "a@b.c" }, { aud: "another-app" }), opts)).rejects.toThrow();
    await expect(verifyAccessJwt(await sign({ email: "a@b.c" }, { iss: "https://evil.cloudflareaccess.com" }), opts)).rejects.toThrow();
    await expect(verifyAccessJwt(await sign({ email: "a@b.c" }, { exp: Math.floor(Date.now() / 1000) - 60 }), opts)).rejects.toThrow();
    const other = await setup(); // signed by a key Access never published
    await expect(verifyAccessJwt(await other.sign({ email: "a@b.c" }), opts)).rejects.toThrow();
  });

  it("returns null when a valid token carries no email (e.g. a service token)", async () => {
    const { keys, sign } = await setup();
    expect(await verifyAccessJwt(await sign({ common_name: "ci-bot" }), { issuer: ISSUER, audience: AUD, keys })).toBeNull();
  });
});
