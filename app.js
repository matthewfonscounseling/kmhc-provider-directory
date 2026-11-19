/* ============================================================
   KMHC Provider Directory
   Reads the published Google Sheet CSV, filters/sorts client-side.
   ============================================================ */

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSr7fJ8DueekLf9xh672BYHJ_8BUH26reOsA6GC1V7SSYG-2A-idNzu7r9JLQJhP7FlMd3iwvXCzbDE/pub?gid=53413515&single=true&output=csv";

// Column positions in the published sheet (0-indexed).
// Columns 17 (notes) and 18 (listserv email) are intentionally
// never read into the display objects below.
const COL = {
  timestamp: 0,
  lastName: 1,
  firstName: 2,
  organization: 3,
  credentials: 4,
  email: 5,
  phone: 6,
  website: 7,
  accepting: 8,
  format: 9,
  location: 10,
  specialties: 11,
  approaches: 12,
  insurance: 13,
  gender: 14,
  ageGroups: 15,
  languages: 16,
  publish: 19
};

const NA_VALUES = new Set(["", "n/a", "na", "none", "null", "-", "n.a.", "not applicable"]);

// ---- Canonical option lists, taken directly from the KMHC intake form.
// Filters only ever offer these choices; a provider's own free-text
// "Other" answers still display on their card, just aren't filterable.
const ACCEPTING_TIERS = ["Yes", "Waitlist Available", "By PCP Referral Only", "No"];
const ACCEPTING_LABELS = {
  "yes": "Accepting Patients",
  "no": "Not Currently Accepting New Patients",
  "waitlist available": "Waitlist Available",
  "by pcp referral only": "By PCP Referral Only"
};

const FORMAT_OPTIONS = ["Telehealth Only", "In-Person Only", "Both telehealth & in-person options"];

const AGE_GROUP_OPTIONS = ["Children (0-12)", "Adolescents (13-17)", "Young adults (18-25)", "Adults (26-64)", "Seniors (65+)"];

const SPECIALTY_OPTIONS = [
  "Addiction & Substance Use", "ADHD", "Anger Management", "Anxiety/ Panic", "Autism Spectrum Disorder",
  "Behavioral Problems", "Child & Adolescent", "Chronic Illness/ Pain", "Couples & Relationships",
  "Depression", "Eating Disorders", "Family Therapy", "Grief & Loss", "Learning Disabilities",
  "LGBTQ+ Affirming", "Life Transitions/ Adjustments", "OCD", "Parenting/ Co-Parenting",
  "Perinatal/ Postpartum", "Sleep Problems", "Spiritual/ Religious", "Testing/ Assessments",
  "Trauma/ PTSD", "Women's Health"
];

const APPROACH_OPTIONS = [
  "Accelerated Resolution Therapy", "Acceptance & Commitment Therapy", "Art/ Expressive Arts Therapy",
  "Brainspotting", "CBT", "CBT-i (for insomnia)", "DBT", "Emotionally Focused Therapy",
  "Emotional Freedom Technique", "EMDR", "Gottman Method", "Internal Family Systems",
  "Mindfulness-Based Therapy", "Play Therapy", "Psychodynamic", "Sand Tray Therapy",
  "Solution-Focused Therapy", "Somatic/ Body-Based Therapy", "Trauma-Focused CBT"
];

const INSURANCE_OPTIONS = [
  "HMSA", "HMSA Quest", "HMSA Akamai Advantage", "Blue Cross Blue Shield", "HMAA",
  "University Health Alliance (UHA)", "United Healthcare (UHC)", "UHC Quest", "UHC Medicare",
  "Kaiser Permanente", "Aetna", "Cigna", "AlohaCare", "AlohaCare Quest", "AlohaCare Medicare",
  "Medicare A & B", "Humana", "MDX AARP", "Devoted", "Healthcare Management Administrators (HMA)",
  "Ohana", "Ohana Quest", "Ohana Medicare", "Tricare", "Triwest", "VA", "AFL Hotel & Restaurant Workers",
  "Sliding scale available", "Self-pay/ Out of pocket", "Workmans Comp"
];

const LANGUAGE_OPTIONS = [
  "ASL (American Sign Language)", "Cantonese", "Tagalog", "Hawaiian", "Illocano", "Japanese",
  "Korean", "Mandarin", "Marshallese", "Portuguese", "Spanish"
];

// Gender: the form also includes "Organization with Multiple Practicing
// Therapists" as a literal choice, but that's handled as a match-all
// wildcard below, never offered as a selectable filter value itself.
const GENDER_OPTIONS = ["Female", "Male", "Non-binary/ gender nonconforming"];
const ORG_GENDER_WILDCARD = "organization with multiple practicing therapists";

const REGIONS = ["North", "East", "Central", "South", "West"];
const REGION_MAP = {
  North: ["hanalei", "kilauea", "princeville"],
  East: ["kapaa", "wailua", "anahola", "hanamaulu"],
  Central: ["lihue", "puhi", "hanamaulu"],
  South: ["koloa", "lawai", "kalaheo"],
  West: ["waimea", "kekaha", "hanapepe", "eleele", "kalaheo", "kaumakani"]
};

let ALL_ITEMS = [];
let VISIBLE_COUNT = 0;
const PAGE_SIZE = 12;

/* ---------------- CSV parsing (handles quoted commas/newlines) ---------------- */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function isNA(v) {
  if (v == null) return true;
  return NA_VALUES.has(String(v).trim().toLowerCase());
}

function clean(v) {
  if (v == null) return "";
  const t = String(v).trim();
  return isNA(t) ? "" : t;
}

function splitExact(value) {
  if (!value) return [];
  return String(value).split(",").map(v => v.trim()).filter(Boolean);
}

function matchesExact(fieldValue, filterValue) {
  if (!filterValue) return true;
  const target = filterValue.trim().toLowerCase();
  return splitExact(fieldValue).some(v => v.toLowerCase() === target);
}

function matchesGender(fieldValue, filterValue) {
  if (!filterValue) return true;
  if (String(fieldValue || "").trim().toLowerCase() === ORG_GENDER_WILDCARD) return true;
  return matchesExact(fieldValue, filterValue);
}

function matchesRegion(locationValue, region) {
  if (!region) return true;
  const cities = splitExact(locationValue).map(c => c.toLowerCase());
  const regionCities = REGION_MAP[region] || [];
  return cities.some(c => regionCities.includes(c));
}

function acceptingTier(value) {
  const vals = splitExact(value).map(v => v.toLowerCase());
  let best = ACCEPTING_TIERS.length; // worst case = last
  ACCEPTING_TIERS.forEach((tier, idx) => {
    if (vals.includes(tier.toLowerCase())) best = Math.min(best, idx);
  });
  return best;
}

function acceptingDisplay(value) {
  // Show each exact tier present, relabeled, joined with " / ".
  const vals = splitExact(value);
  if (!vals.length) return "";
  const labels = vals.map(v => ACCEPTING_LABELS[v.toLowerCase()] || v);
  // de-dupe while preserving order
  return [...new Set(labels)].join(" / ");
}

function ageGroupsDisplay(value) {
  const vals = new Set(splitExact(value).map(v => v.toLowerCase()));
  const all = AGE_GROUP_OPTIONS.map(v => v.toLowerCase());
  const adultsSet = ["young adults (18-25)", "adults (26-64)", "seniors (65+)"];
  const youthSet = ["children (0-12)", "adolescents (13-17)"];

  const equalsSet = (a, b) => a.size === b.length && b.every(v => a.has(v));

  if (equalsSet(vals, all)) return "All Ages";
  if (equalsSet(vals, adultsSet)) return "Adults";
  if (equalsSet(vals, youthSet)) return "Children and Adolescents";
  return value;
}

/* ---------------- Load + transform ---------------- */
async function loadData() {
  const res = await fetch(SHEET_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load provider data: " + res.status);
  const text = await res.text();
  const rows = parseCSV(text).filter(r => r.length > 1);
  rows.shift(); // drop header row

  // Map keyed by a per-provider identity; later rows (later form
  // submissions, since Form Responses always append chronologically)
  // overwrite earlier ones with the same identity, so duplicate/stale
  // entries for the same provider automatically collapse to the most
  // recently submitted row.
  const byIdentity = new Map();

  for (const r of rows) {
    const firstName = clean(r[COL.firstName]);
    const lastName = clean(r[COL.lastName]);
    const organization = clean(r[COL.organization]);
    if (!firstName && !lastName && !organization) continue; // skip blank rows

    const publishFlag = String(r[COL.publish] || "").trim().toUpperCase();
    if (publishFlag !== "X") continue; // only show rows marked ready

    const identityKey = ((firstName + " " + lastName).trim() || organization).toLowerCase();

    byIdentity.set(identityKey, {
      firstName,
      lastName,
      organization,
      credentials: clean(r[COL.credentials]),
      email: clean(r[COL.email]),
      phone: clean(r[COL.phone]),
      website: clean(r[COL.website]),
      accepting: clean(r[COL.accepting]),
      format: clean(r[COL.format]),
      location: clean(r[COL.location]),
      specialties: clean(r[COL.specialties]),
      approaches: clean(r[COL.approaches]),
      insurance: clean(r[COL.insurance]),
      gender: clean(r[COL.gender]),
      ageGroups: clean(r[COL.ageGroups]),
      languages: clean(r[COL.languages]),
      _rand: Math.random()
    });
  }
  return Array.from(byIdentity.values());
}

/* ---------------- Dropdown population ---------------- */
function fillSelect(selectEl, options, placeholder, labelFn) {
  selectEl.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = placeholder;
  selectEl.appendChild(optAll);
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = labelFn ? labelFn(opt) : opt;
    selectEl.appendChild(o);
  });
}

function populateFilters() {
  fillSelect(
    document.getElementById("f-accepting"),
    ACCEPTING_TIERS,
    "Accepting new patients: Any",
    v => ACCEPTING_LABELS[v.toLowerCase()] || v
  );
  fillSelect(document.getElementById("f-insurance"), INSURANCE_OPTIONS, "Insurance / Payment: Any");
  fillSelect(document.getElementById("f-format"), FORMAT_OPTIONS, "Telehealth / In-person: Any");
  fillSelect(document.getElementById("f-location"), REGIONS, "Location: Any region");
  fillSelect(document.getElementById("f-age"), AGE_GROUP_OPTIONS, "Age groups: Any");
  fillSelect(document.getElementById("f-specialties"), SPECIALTY_OPTIONS, "Specialties: Any");
  fillSelect(document.getElementById("f-approaches"), APPROACH_OPTIONS, "Treatment approaches: Any");
  fillSelect(document.getElementById("f-gender"), GENDER_OPTIONS, "Therapist Gender: Any");
  fillSelect(document.getElementById("f-language"), LANGUAGE_OPTIONS, "Language: Any");
}

/* ---------------- Filtering / sorting ---------------- */
function getVal(id) {
  return document.getElementById(id).value || "";
}

function runFilter() {
  const nameRaw = document.getElementById("nameSearch").value.trim().toLowerCase();
  const accepting = getVal("f-accepting");
  const insurance = getVal("f-insurance");
  const format = getVal("f-format");
  const region = getVal("f-location");
  const age = getVal("f-age");
  const specialties = getVal("f-specialties");
  const approaches = getVal("f-approaches");
  const gender = getVal("f-gender");
  const language = getVal("f-language");

  let items = ALL_ITEMS.filter(it => {
    if (nameRaw) {
      const haystack = (it.firstName + " " + it.lastName + " " + it.organization).toLowerCase();
      if (!haystack.includes(nameRaw)) return false;
    }
    if (accepting && !matchesExact(it.accepting, accepting)) return false;
    if (insurance && !matchesExact(it.insurance, insurance)) return false;
    if (format && !matchesExact(it.format, format)) return false;
    if (region && !matchesRegion(it.location, region)) return false;
    if (age && !matchesExact(it.ageGroups, age)) return false;
    if (specialties && !matchesExact(it.specialties, specialties)) return false;
    if (approaches && !matchesExact(it.approaches, approaches)) return false;
    if (gender && !matchesGender(it.gender, gender)) return false;
    if (language && !matchesExact(it.languages, language)) return false;
    return true;
  });

  items.sort((a, b) => {
    const ta = acceptingTier(a.accepting);
    const tb = acceptingTier(b.accepting);
    if (ta !== tb) return ta - tb;
    return a._rand - b._rand;
  });

  VISIBLE_COUNT = 0;
  renderResults(items, true);
}

/* ---------------- Rendering ---------------- */
let CURRENT_LIST = [];

function renderResults(items, reset) {
  if (reset) CURRENT_LIST = items;
  const container = document.getElementById("results");
  const statusLine = document.getElementById("statusLine");
  const loadMoreBtn = document.getElementById("loadMoreBtn");

  if (reset) container.innerHTML = "";

  if (CURRENT_LIST.length === 0) {
    container.innerHTML = '<div class="empty-state">No providers match these filters. Try clearing a filter or <button id="emptyReset" style="color:#2a7c6f;text-decoration:underline;background:none;border:none;cursor:pointer;font:inherit;">reset</button>.</div>';
    const er = document.getElementById("emptyReset");
    if (er) er.addEventListener("click", resetFilters);
    statusLine.textContent = "0 providers found";
    loadMoreBtn.hidden = true;
    return;
  }

  const nextSlice = CURRENT_LIST.slice(VISIBLE_COUNT, VISIBLE_COUNT + PAGE_SIZE);
  nextSlice.forEach(it => container.appendChild(buildCard(it)));
  VISIBLE_COUNT += nextSlice.length;

  statusLine.textContent = `Showing ${VISIBLE_COUNT} of ${CURRENT_LIST.length} providers`;
  loadMoreBtn.hidden = VISIBLE_COUNT >= CURRENT_LIST.length;
}

function tierClass(accepting) {
  const t = acceptingTier(accepting);
  return ["tier-yes", "tier-waitlist", "tier-referral", "tier-no"][t] || "tier-no";
}

function fieldRow(label, value) {
  if (!value) return "";
  return `<div class="field"><span class="label">${label}:</span>${escapeHTML(value)}</div>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function normalizeWebsite(url) {
  if (!url) return "";
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function displayWebsite(url) {
  // Strip protocol + trailing slash for a cleaner button label.
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function buildCard(it) {
  const card = document.createElement("div");
  card.className = "card";

  const displayName = (it.firstName || it.lastName)
    ? `${it.firstName} ${it.lastName}`.trim()
    : it.organization;
  const subOrg = (it.firstName || it.lastName) && it.organization ? it.organization : "";

  let html = "";
  html += `<h3 class="name">${escapeHTML(displayName)}</h3>`;
  if (subOrg) html += `<div class="org">${escapeHTML(subOrg)}</div>`;
  if (it.credentials) html += `<div class="credentials">${escapeHTML(it.credentials)}</div>`;
  if (it.accepting) {
    html += `<span class="accepting ${tierClass(it.accepting)}">${escapeHTML(acceptingDisplay(it.accepting))}</span>`;
  }
  html += fieldRow("Format", it.format);
  html += fieldRow("Location", it.location);
  html += fieldRow("Specialties", it.specialties);
  html += fieldRow("Treatment approaches", it.approaches);
  html += fieldRow("Insurance / Payment", it.insurance);
  html += fieldRow("Therapist Gender", it.gender);
  if (it.ageGroups) html += fieldRow("Age groups served", ageGroupsDisplay(it.ageGroups));
  if (it.languages) html += fieldRow("Languages spoken", it.languages);

  const contacts = [];
  if (it.phone) {
    contacts.push(`<a href="tel:${escapeHTML(it.phone.replace(/[^+\d]/g, ""))}"><span class="icon">&#128222;</span>${escapeHTML(it.phone)}</a>`);
  }
  if (it.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(it.email)) {
    contacts.push(`<a href="mailto:${escapeHTML(it.email)}"><span class="icon">&#9993;</span>${escapeHTML(it.email)}</a>`);
  }
  if (it.website) {
    const href = normalizeWebsite(it.website);
    contacts.push(`<a href="${escapeHTML(href)}" target="_blank" rel="noopener"><span class="icon">&#127760;</span>${escapeHTML(displayWebsite(it.website))}</a>`);
  }
  if (contacts.length) html += `<div class="contact">${contacts.join("")}</div>`;

  card.innerHTML = html;
  return card;
}

/* ---------------- Controls ---------------- */
function resetFilters() {
  document.getElementById("nameSearch").value = "";
  ["f-accepting", "f-insurance", "f-format", "f-location", "f-age", "f-specialties", "f-approaches", "f-gender", "f-language"]
    .forEach(id => document.getElementById(id).value = "");
  runFilter();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------------- Init ---------------- */
async function init() {
  const statusLine = document.getElementById("statusLine");
  statusLine.textContent = "Loading providers…";

  populateFilters();

  try {
    ALL_ITEMS = await loadData();
  } catch (err) {
    statusLine.textContent = "Couldn't load the provider list right now. Please refresh, or check back soon.";
    console.error(err);
    return;
  }

  const debouncedFilter = debounce(runFilter, 200);
  document.getElementById("nameSearch").addEventListener("input", debouncedFilter);
  ["f-accepting", "f-insurance", "f-format", "f-location", "f-age", "f-specialties", "f-approaches", "f-gender", "f-language"]
    .forEach(id => document.getElementById(id).addEventListener("change", runFilter));
  document.getElementById("resetBtn").addEventListener("click", resetFilters);
  document.getElementById("loadMoreBtn").addEventListener("click", () => renderResults(CURRENT_LIST, false));

  const moreBtn = document.getElementById("moreFiltersToggle");
  const extra = document.getElementById("extraFilters");
  moreBtn.addEventListener("click", () => {
    const open = extra.classList.toggle("open");
    moreBtn.setAttribute("aria-expanded", String(open));
    moreBtn.innerHTML = open ? "Fewer filters &#9652;" : "More filters &#9662;";
  });

  runFilter();
}

document.addEventListener("DOMContentLoaded", init);
