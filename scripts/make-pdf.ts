// Generates fixtures/notices/08-epinephrine-letter.pdf: a minimal, valid single-page text PDF.
// Run: node scripts/make-pdf.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lines = [
  "HARBORLINE PHARMACEUTICAL DISTRIBUTION",
  "Allocation Letter  -  Reference HPD-EM-2026-311",
  "Date: November 3, 2026",
  "To: Riverbend Health, Central Pharmacy",
  "",
  "Emergency syringe products remain on allocation. Your allocation for this cycle:",
  "",
  "1. Epinephrine Injection 0.1 mg/mL (1 mg/10 mL) prefilled syringe  -  300 syringes",
  "2. Atropine Sulfate Injection 0.1 mg/mL, 10 mL prefilled syringe  -  120 syringes",
  "",
  "Estimated delivery: November 16, 2026.",
  "Quantities above are final for this cycle and cannot be increased.",
];

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const content = ["BT", "/F1 11 Tf", "14 TL", "60 760 Td", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "notices", "08-epinephrine-letter.pdf");
writeFileSync(out, pdf, "latin1");
console.log(`wrote ${out}`);
