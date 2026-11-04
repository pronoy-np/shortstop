// Generates packages/db/seed.sql. Deterministic: same output every run.
// Run: node packages/db/scripts/seed.ts  (Node >= 22.18 strips types natively)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Drug = [id: string, name: string, drugClass: string, tier: 1 | 2 | 3, unit: string];

// Drugs that have appeared on US shortage lists; ops data around them is synthetic.
export const DRUGS: Drug[] = [
  ["cisplatin", "Cisplatin 1 mg/mL injection 50 mL", "oncology", 1, "vial"],
  ["carboplatin", "Carboplatin 10 mg/mL injection 45 mL", "oncology", 1, "vial"],
  ["methotrexate", "Methotrexate 25 mg/mL injection 2 mL", "oncology", 1, "vial"],
  ["fluorouracil", "Fluorouracil 50 mg/mL injection 50 mL", "oncology", 1, "vial"],
  ["vincristine", "Vincristine 1 mg/mL injection", "oncology", 1, "vial"],
  ["epinephrine-syr", "Epinephrine 0.1 mg/mL 10 mL prefilled syringe", "emergency", 1, "syringe"],
  ["epinephrine-vial", "Epinephrine 1 mg/mL 1 mL vial", "emergency", 1, "vial"],
  ["atropine-syr", "Atropine 0.1 mg/mL 10 mL prefilled syringe", "emergency", 1, "syringe"],
  ["sodium-bicarb-syr", "Sodium bicarbonate 8.4% 50 mL syringe", "emergency", 1, "syringe"],
  ["dextrose-50", "Dextrose 50% 50 mL syringe", "emergency", 1, "syringe"],
  ["heparin", "Heparin 1,000 units/mL 10 mL vial", "anticoagulant", 1, "vial"],
  ["norepinephrine", "Norepinephrine 1 mg/mL 4 mL vial", "vasopressor", 1, "vial"],
  ["propofol", "Propofol 10 mg/mL 100 mL vial", "sedation", 1, "vial"],
  ["midazolam", "Midazolam 1 mg/mL 10 mL vial", "sedation", 1, "vial"],
  ["fentanyl", "Fentanyl 50 mcg/mL 2 mL ampule", "opioid", 1, "ampule"],
  ["hydromorphone", "Hydromorphone 1 mg/mL 1 mL vial", "opioid", 1, "vial"],
  ["lidocaine-syr", "Lidocaine 2% 5 mL prefilled syringe", "anesthetic", 1, "syringe"],
  ["nacl-1000", "Sodium chloride 0.9% 1,000 mL bag", "iv_fluids", 1, "bag"],
  ["lr-1000", "Lactated Ringer's 1,000 mL bag", "iv_fluids", 1, "bag"],
  ["amoxicillin-susp", "Amoxicillin 400 mg/5 mL oral suspension 100 mL", "antibiotic", 2, "bottle"],
  ["cefdinir-susp", "Cefdinir 250 mg/5 mL oral suspension 100 mL", "antibiotic", 2, "bottle"],
  ["cefazolin", "Cefazolin 1 g vial", "antibiotic", 2, "vial"],
  ["ceftriaxone", "Ceftriaxone 1 g vial", "antibiotic", 2, "vial"],
  ["pip-tazo", "Piperacillin-tazobactam 3.375 g vial", "antibiotic", 2, "vial"],
  ["vancomycin", "Vancomycin 1 g vial", "antibiotic", 2, "vial"],
  ["amphetamine-salts", "Amphetamine mixed salts 20 mg tablet (100 ct)", "stimulant", 2, "bottle"],
  ["methylphenidate-er", "Methylphenidate ER 36 mg tablet (100 ct)", "stimulant", 2, "bottle"],
  ["albuterol-neb", "Albuterol 2.5 mg/3 mL nebulizer solution (25 ct)", "respiratory", 2, "box"],
  ["ondansetron", "Ondansetron 2 mg/mL 2 mL vial", "antiemetic", 2, "vial"],
  ["furosemide", "Furosemide 10 mg/mL 4 mL vial", "diuretic", 2, "vial"],
  ["kcl-inj", "Potassium chloride 2 mEq/mL 20 mL vial", "electrolyte", 2, "vial"],
  ["dexamethasone", "Dexamethasone 4 mg/mL 1 mL vial", "steroid", 2, "vial"],
  ["lorazepam", "Lorazepam 2 mg/mL 1 mL vial", "sedation", 2, "vial"],
  ["diltiazem", "Diltiazem 5 mg/mL 5 mL vial", "cardiac", 2, "vial"],
  ["semaglutide", "Semaglutide 1 mg/0.75 mL pen", "glp1", 3, "pen"],
  ["liraglutide", "Liraglutide 18 mg/3 mL pen", "glp1", 3, "pen"],
  ["tirzepatide", "Tirzepatide 5 mg/0.5 mL pen", "glp1", 3, "pen"],
  ["sterile-water", "Sterile water for injection 10 mL vial", "diluent", 3, "vial"],
  ["famotidine", "Famotidine 10 mg/mL 2 mL vial", "gi", 3, "vial"],
  ["metoclopramide", "Metoclopramide 5 mg/mL 2 mL vial", "gi", 3, "vial"],
];

export const SUBSTITUTES: [drug: string, substitute: string, note: string][] = [
  ["cisplatin", "carboplatin", "Platinum alternative; regimen-dependent, oncology pharmacist review required"],
  ["carboplatin", "cisplatin", "Platinum alternative; renal function and emetogenicity differ"],
  ["epinephrine-syr", "epinephrine-vial", "Dilute 1 mg/mL vial to 0.1 mg/mL; compounding error risk"],
  ["nacl-1000", "lr-1000", "Balanced crystalloid; avoid where hyperkalemia is a concern"],
  ["lr-1000", "nacl-1000", "Normal saline; monitor for hyperchloremic acidosis"],
  ["amoxicillin-susp", "cefdinir-susp", "Oral cephalosporin alternative for pediatric otitis media"],
  ["cefazolin", "ceftriaxone", "Broader spectrum; surgical prophylaxis protocol change"],
  ["fentanyl", "hydromorphone", "Opioid conversion required"],
  ["propofol", "midazolam", "Alternative sedation; different titration and recovery profile"],
  ["amphetamine-salts", "methylphenidate-er", "Alternative stimulant class; prescriber re-titration"],
  ["semaglutide", "liraglutide", "Daily GLP-1 alternative"],
  ["semaglutide", "tirzepatide", "Dual GIP/GLP-1 alternative; dose conversion needed"],
];

type Site = [id: string, name: string, region: string, acuity: 1 | 2 | 3];

export const SITES: Site[] = [
  ["rumc", "Riverbend University Medical Center", "Central", 1],
  ["rci", "Riverbend Cancer Institute", "Central", 1],
  ["lch", "Lakeside Children's Hospital", "North", 1],
  ["scr", "St. Clare Regional", "East", 2],
  ["mvh", "Mill Valley Hospital", "West", 2],
  ["hgh", "Harbor General", "South", 2],
  ["pmc", "Prairie Medical Center", "West", 2],
  ["nch", "Northfield Community Hospital", "North", 3],
  ["cch", "Cedar Creek Hospital", "East", 3],
  ["ofh", "Oakford Family Hospital", "South", 3],
];

export const USERS: [email: string, name: string, role: "planner" | "pharmacist" | "ops_lead"][] = [
  ["priya@shortstop.demo", "Priya Raman", "planner"],
  ["marcus@shortstop.demo", "Marcus Webb", "planner"],
  ["dana@shortstop.demo", "Dana Okafor", "pharmacist"],
  ["olu@shortstop.demo", "Olu Adeyemi", "ops_lead"],
  ["pronoy.pant@newpage.io", "Pronoy Pant", "ops_lead"],
];

export const DEFAULT_POLICY = [
  { id: "tier1-manual", when: { tier: 1 }, then: "manual_only" },
  { id: "antibiotics-propose", when: { drugClass: "antibiotic" }, then: "propose" },
  { id: "small-confident-auto", when: { maxLotQty: 500, minConfidence: 0.85 }, then: "auto_commit" },
];

// Mulberry32: tiny deterministic PRNG so the seed is reproducible.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;

export function buildSeedSql(): string {
  const rand = rng(42);
  const lines: string[] = ["-- Generated by packages/db/scripts/seed.ts. Do not edit by hand."];
  const tables = ["cover_history", "allocations", "lots", "notices", "audit_log", "dead_letters", "policy_versions", "stock", "substitutes", "users", "drugs", "sites"];
  for (const t of tables) lines.push(`DELETE FROM ${t};`);

  for (const [id, name, region, acuity] of SITES)
    lines.push(`INSERT INTO sites VALUES (${q(id)}, ${q(name)}, ${q(region)}, ${acuity});`);
  for (const [id, name, cls, tier, unit] of DRUGS)
    lines.push(`INSERT INTO drugs VALUES (${q(id)}, ${q(name)}, NULL, ${q(cls)}, ${tier}, ${q(unit)});`);
  for (const [d, s, note] of SUBSTITUTES)
    lines.push(`INSERT INTO substitutes VALUES (${q(d)}, ${q(s)}, ${q(note)});`);
  for (const [email, name, role] of USERS)
    lines.push(`INSERT INTO users VALUES (${q(email)}, ${q(name)}, ${q(role)});`);

  for (const [siteId, , , acuity] of SITES) {
    for (const [drugId, , cls] of DRUGS) {
      // Bigger, higher-acuity sites use more; oncology concentrates at rci/rumc, pediatrics at lch.
      let demand = (4 - acuity) * (0.5 + rand() * 2);
      if (cls === "oncology") demand *= siteId === "rci" ? 4 : siteId === "rumc" ? 1.5 : 0.3;
      if (drugId === "amoxicillin-susp" || drugId === "cefdinir-susp") demand *= siteId === "lch" ? 4 : 0.6;
      if (cls === "iv_fluids") demand *= 8;
      demand = Math.round(demand * 10) / 10;
      // Shortage conditions: most sites hold 1-11 days of cover, so splits matter and substitutes come up.
      const coverDays = 1 + rand() * 10;
      const onHand = Math.round(demand * coverDays);
      lines.push(`INSERT INTO stock VALUES (${q(siteId)}, ${q(drugId)}, ${onHand}, 0, ${demand});`);
    }
  }

  lines.push(
    `INSERT INTO policy_versions VALUES (1, ${q(JSON.stringify(DEFAULT_POLICY))}, 'olu@shortstop.demo', 1767225600000);`,
  );
  return lines.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "seed.sql");
  writeFileSync(out, buildSeedSql());
  console.log(`wrote ${out}`);
}
