// Sample notices served from `public/notices` (a symlink to fixtures/notices). Client-safe: no server imports.

export const SAMPLES: [file: string, label: string][] = [
  ["notices/01-meridian-multi-lot.txt", "Multi-lot notice (text)"],
  ["notices/02-cisplatin-oncology.eml", "Cisplatin allocation (.eml)"],
  ["notices/03-iv-fluids-short.txt", "IV fluids, very short"],
  ["notices/04-pediatric-amoxicillin.txt", "Pediatric amoxicillin"],
  ["notices/05-glp1-pens.txt", "GLP-1 pens"],
  ["notices/06-not-a-notice.txt", "Not a notice (triage)"],
  ["notices/07-unknown-product.txt", "Unknown product (triage)"],
  ["notices/08-epinephrine-letter.pdf", "Emergency syringes (PDF)"],
];

/** The samples on the board's start guide, one per path through the desk (the last one lands in triage). */
export const JOURNEY_SAMPLES: { file: string; label: string }[] = [
  { file: "notices/01-meridian-multi-lot.txt", label: "Multi-lot notice" },
  { file: "notices/03-iv-fluids-short.txt", label: "IV fluids, very short" },
  { file: "notices/02-cisplatin-oncology.eml", label: "Cisplatin (oncology)" },
  { file: "notices/06-not-a-notice.txt", label: "Not a notice" },
];

const TYPES: Record<string, string> = { txt: "text/plain", eml: "message/rfc822", pdf: "application/pdf" };

export const sampleName = (path: string) => path.split("/").pop()!;

/** Fetches a sample as a File, keeping its real filename so the board can tell it is already there. */
export async function fetchSample(path: string): Promise<File> {
  const res = await fetch(`/${path}`);
  if (!res.ok) throw new Error(`could not load the sample (${res.status})`);
  const name = sampleName(path);
  return new File([await res.blob()], name, { type: TYPES[name.split(".").pop()!] ?? "application/octet-stream" });
}
