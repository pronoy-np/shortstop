import { describe, expect, it } from "vitest";
import { confirmationBase } from "./confirmation-key";

describe("confirmationBase", () => {
  it("leaves ordinary keys alone", () => {
    expect(confirmationBase("n_a-1", "n_a-1:3f2c9d1e-aaaa-bbbb-cccc-123456789abc")).toBe("confirmations/n_a-1/n_a-1:3f2c9d1e-aaaa-bbbb-cccc-123456789abc");
    expect(confirmationBase("n_a-1", "auto:n_a-1")).toBe("confirmations/n_a-1/auto:n_a-1");
  });

  it("never gives two different keys the same path", () => {
    const keys = ["key.0001", "key_0001", "key 0001", "key/0001", "key.002e0001", "ké0001", "ke0001"];
    const paths = keys.map((k) => confirmationBase("n_a-1", k));
    expect(new Set(paths).size).toBe(keys.length);
  });

  it("yields only characters the /api/files key pattern accepts", () => {
    const path = confirmationBase("n_a-1", "we ird/ké\u{1F600}../key");
    expect(path).toMatch(/^confirmations\/[a-zA-Z0-9_:.-]+\/[a-zA-Z0-9_:.-]+$/);
  });
});
