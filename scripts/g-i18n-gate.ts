/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  g-i18n-gate — GATE i18n du runner G (avant build, comme le gate tsc)
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. Catalogues présents + parité stricte fr/en (clés + placeholders {var})
 *     + zéro clé dupliquée (détection au niveau du TEXTE JSON : JSON.parse
 *     dédupliquerait en silence).
 *  2. TOUTE clé t()/tp() utilisée dans src/ existe dans les DEUX catalogues —
 *     une typo de clé ne peut plus passer (le runtime warn + rend la clé :
 *     jamais silencieux, mais le gate la bloque AVANT).
 *  3. Sentinelles : chaînes FR historiques extraites → 0 occurrence dans le
 *     CODE de src/components/ (les commentaires sont strippés avant comparaison
 *     — les mentions d'harnais dans les commentaires sont légitimes).
 *  Exit 1 sur tout échec (jamais silencieux).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failed = false;
const fail = (msg: string): void => {
  failed = true;
  console.error(`GATE-FAIL — ${msg}`);
};

// ── 1. catalogues ─────────────────────────────────────────────────────────────
const rawFr = readFileSync(join(ROOT, "locales", "fr.json"), "utf8");
const rawEn = readFileSync(join(ROOT, "locales", "en.json"), "utf8");

for (const [name, raw] of [["fr", rawFr], ["en", rawEn]] as const) {
  const keys = [...raw.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) fail(`clé(s) dupliquée(s) dans locales/${name}.json : ${dup.join(", ")}`);
}

type Catalog = Record<string, string>;
const fr = JSON.parse(rawFr) as Catalog;
const en = JSON.parse(rawEn) as Catalog;
const frKeys = Object.keys(fr).sort();
const enKeys = Object.keys(en).sort();
const onlyFr = frKeys.filter((k) => !(k in en));
const onlyEn = enKeys.filter((k) => !(k in fr));
if (onlyFr.length || onlyEn.length) {
  fail(`parité fr/en rompue — fr seul: ${onlyFr.slice(0, 10).join(", ")}… ; en seul: ${onlyEn.slice(0, 10).join(", ")}…`);
}
const placeholders = (s: string): string[] =>
  (s.match(/\{(\w+)\}/g) ?? []).sort();
for (const k of frKeys) {
  if (!(k in en)) continue;
  const a = placeholders(fr[k]).join(",");
  const b = placeholders(en[k]).join(",");
  if (a !== b) fail(`placeholders divergents pour « ${k} » — fr[${a}] en[${b}]`);
}
console.log(`gate 1 ok — ${frKeys.length} clés par locale, parité + placeholders vérifiées (en l'état)`);

// ── 2. clés utilisées dans le code ⊆ catalogues ──────────────────────────────
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const srcFiles = [
  ...walk(join(ROOT, "src", "components"), [".tsx", ".ts"]),
  ...walk(join(ROOT, "src", "lib", "mbote"), [".tsx", ".ts"]),
];
const usedKeys = new Set<string>();
const dynamicPrefixes = new Set<string>();
const KEY_RE = /\bt(?:p)?\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`]+)`)/g;
for (const f of srcFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(KEY_RE)) {
    const lit = m[1] ?? m[2];
    const tpl = m[3];
    if (lit) usedKeys.add(lit);
    else if (tpl && !tpl.includes("${")) usedKeys.add(tpl.trim());
    else if (tpl) dynamicPrefixes.add(tpl.split("${")[0].trim());
  }
}
const missing: string[] = [];
for (const k of usedKeys) {
  // Une clé tp() est référencée par sa BASE (k) — le runtime résout k.one/k.other
  // via Intl.PluralRules : la base est résolue si au moins une variante existe.
  const pluralOk = `${k}.one` in fr || `${k}.other` in fr;
  if (!(k in fr) && !pluralOk) missing.push(`fr:${k}`);
  if (!(k in en) && !(`${k}.one` in en || `${k}.other` in en)) missing.push(`en:${k}`);
}
if (missing.length) fail(`clés utilisées dans le code absentes des catalogues : ${missing.slice(0, 20).join(", ")}`);
for (const p of dynamicPrefixes) {
  if (!frKeys.some((k) => k.startsWith(p))) fail(`préfixe dynamique sans clé au catalogue : « ${p} »`);
}
console.log(`gate 2 ok — ${usedKeys.size} clés statiques + ${dynamicPrefixes.size} préfixes dynamiques résolus`);

// ── 3. sentinelles : extraits → 0 occurrence dans le CODE ────────────────────
const SENTINELS = [
  "Nouvelle conversation",
  "Crée ton identité locale",
  "Générer mes clés et entrer",
  "Nouveau groupe",
  "Nom du groupe",
  "Tout effacer",
  "Effacer définitivement",
  "Modifier le profil",
  "Notifications push",
  "Activer les notifications",
  "Le fil global attend ton premier message",
  "Choisir un contact",
  "Chiffrer et envoyer",
  "Hors-ligne — ton courrier partira",
  "Message à publier",
  "Envoyer une note vocale",
  "Appel vidéo entrant",
  "Saisissez au moins 2 caractères",
  "Résultats du fil public",
  "Créer mon identité",
  "Rechercher un mot dans le fil public",
  "Aucun résultat pour",
  "Envoyer le message chiffré",
  "Message privé",
  "Groupe créé",
  "Rechercher dans les fils publics",
  "Fil public : serveur (FTS5)",
  "Préférences",
];
/** Strippage heuristique des commentaires (les URLs « https:// » ne sont pas
 *  touchées : le // requiert une limite de mot avant). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
}
const leftovers: string[] = [];
for (const s of SENTINELS) {
  for (const f of srcFiles.filter((f) => f.includes("components"))) {
    const code = stripComments(readFileSync(f, "utf8"));
    if (code.includes(s)) {
      leftovers.push(`${s} → ${f.replace(ROOT + "/", "")}`);
      break;
    }
  }
}
if (leftovers.length) fail(`textes FR historiques encore dans le code :\n  ${leftovers.join("\n  ")}`);
console.log(`gate 3 ok — ${SENTINELS.length} sentinelles absentes du code de src/components/`);

if (failed) process.exit(1);
console.log("GATE i18n VERT — parité, clés résolues, extraction prouvée.");
