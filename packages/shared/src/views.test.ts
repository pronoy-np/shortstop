import { describe, expect, it } from "vitest";
import { csvCell } from "./views";

describe("csvCell", () => {
  it("quotes every cell and doubles inner quotes (RFC 4180)", () => {
    expect(csvCell('Cefazolin 1 g "vial"')).toBe('"Cefazolin 1 g ""vial"""');
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("neutralises text a spreadsheet would run as a formula", () => {
    for (const bad of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])
      expect(csvCell(bad)).toBe(`"'${bad.replaceAll('"', '""')}"`);
  });

  it("leaves numbers and ordinary text alone", () => {
    expect(csvCell(-5)).toBe('"-5"');
    expect(csvCell(120)).toBe('"120"');
    expect(csvCell("2026-11-03T10:00:00.000Z")).toBe('"2026-11-03T10:00:00.000Z"');
    expect(csvCell("autopilot:small-confident-auto@v1")).toBe('"autopilot:small-confident-auto@v1"');
  });
});
