/* ============================================================
   KMHC Provider Directory
   Reads the published Google Sheet CSV, filters/sorts client-side.
   ============================================================ */

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSr7fJ8DueekLf9xh672BYHJ_8BUH26reOsA6GC1V7SSYG-2A-idNzu7r9JLQJhP7FlMd3iwvXCzbDE/pub?gid=53413515&single=true&output=csv";

// The old Wix directory, imported and reconciled once, published as its
// own separate sheet tab/CSV (NOT mixed into the main sheet's Form
// Responses -> Public Data formula chain, which is just a row-for-row
// mirror pre-filled many rows ahead for future form submissions --
// splicing legacy rows into unused rows there would eventually collide
// with a real submission landing on the same row). Same column layout
// as the main sheet (see COL below), so it's parsed with the same logic;
// every row from this feed is treated as legacy, unconditionally.
const LEGACY_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSr7fJ8DueekLf9xh672BYHJ_8BUH26reOsA6GC1V7SSYG-2A-idNzu7r9JLQJhP7FlMd3iwvXCzbDE/pub?gid=1584016534&single=true&output=csv";

// On/after this date the legacy feed is ignored entirely -- those ~90
// imported-but-unconfirmed people simply stop appearing, rather than
// sitting at "Waitlist Available" forever. By then the import is over a
// year stale and not worth carrying any further.
const LEGACY_CUTOFF_DATE = new Date("2028-01-01T00:00:00");

// Quarterly "are you still accepting?" attestation form responses.
// Columns (0-indexed): 0 = Timestamp, 1 = First Name, 2 = Last Name,
// 3 = their selected accepting-status option (single-choice/multiple-choice
// question, not checkboxes, so normally exactly one value). Matched
// against providers by normalized first+last name (not email -- not
// every provider has one).
const ATTESTATION_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT4ADkkAjmT1fdA9q_EClvII0AAd3nQhvFlzf1H2wIJx2bJ_0qWaBQHLPOfdURXvmZdcypEQ-Arfrzf/pub?output=csv";

// A provider's most recent attestation (or, for someone who's never
// attested, see BOOTSTRAP_ATTESTATION_DATE below) is considered stale
// once it's older than this -- 100 days running continuously from
// whenever they last attested, not tied to calendar quarters. Reminder
// emails go out once a quarter, but that's just a nudge; the actual
// staleness clock is a rolling 100 days per person.
const ATTESTATION_STALE_DAYS = 100;

// Providers who have never submitted an attestation are treated as if
// they'd attested on this date, for the sole purpose of computing
// staleness -- this is what makes the system self-bootstrapping without
// a separate before/after cutover date. Before this date, "never
// attested" computes as not-yet-stale (the clock hasn't started);
// ATTESTATION_STALE_DAYS after it, "never attested" becomes stale the
// same way an old real attestation would.
const BOOTSTRAP_ATTESTATION_DATE = new Date("2027-01-01T00:00:00");

// Defensive: the question is multiple-choice (single answer) now, not
// checkboxes, so there's normally exactly one value here. If a legacy/
// malformed row somehow has more than one, the most restrictive/cautious
// option wins (better to under-promise than send someone to a provider
// who is actually not taking new patients).
const ATTESTATION_CONFLICT_PRIORITY = ["No", "By PCP Referral Only", "Waitlist Available", "Yes"];

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

// Simplified filter the person actually picks from: "Telehealth" or
// "In-Person" (plus the default "Any"). A provider who offers both counts
// as a match for either simplified choice, since someone who wants
// telehealth is also served by a provider who offers both, and likewise
// for in-person.
const FORMAT_FILTER_OPTIONS = ["Telehealth", "In-Person"];
const FORMAT_FILTER_GROUPS = {
  "telehealth": ["telehealth only", "both telehealth & in-person options"],
  "in-person": ["in-person only", "both telehealth & in-person options"]
};

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

// Normalizes a typed full name for matching: lowercase, strip quotes/
// punctuation (people type nicknames like "Jaye" or middle initials
// inconsistently), collapse whitespace. Not foolproof against typos, but
// catches the common formatting noise seen in this roster's name data.
function normalizeName(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/["'‘’“”.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function matchesFormat(fieldValue, filterValue) {
  if (!filterValue) return true;
  const target = FORMAT_FILTER_GROUPS[filterValue.trim().toLowerCase()] || [];
  return splitExact(fieldValue).some(v => target.includes(v.toLowerCase()));
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

// Fetches text from a CSV URL, returning "" (never throwing) on failure.
// Used for the two optional/supplementary feeds (legacy, attestations) so
// a hiccup in either never takes down the whole directory; the required
// main-sheet fetch is handled separately below since its failure should
// surface as an error.
async function fetchTextOrEmpty(url, label) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error(label + " fetch failed with status " + res.status);
      return "";
    }
    return await res.text();
  } catch (err) {
    console.error(label + " fetch failed:", err);
    return "";
  }
}

/* ---------------- Load + transform ---------------- */
async function loadData() {
  // All three sheets are independent published CSVs on separate Google
  // endpoints, so there's no reason to wait on one before starting the
  // next -- fetch them all in parallel rather than one after another.
  const [mainText, legacyText, attestationText] = await Promise.all([
    fetch(SHEET_CSV_URL, { cache: "no-store" }).then(res => {
      if (!res.ok) throw new Error("Failed to load provider data: " + res.status);
      return res.text();
    }),
    fetchTextOrEmpty(LEGACY_CSV_URL, "Legacy import"),
    fetchTextOrEmpty(ATTESTATION_CSV_URL, "Attestation")
  ]);

  const rows = parseCSV(mainText).filter(r => r.length > 1);
  rows.shift(); // drop header row

  // Map keyed by a per-provider identity. When two rows share an identity
  // (duplicate/updated submissions for the same provider), the row with
  // the LATER parsed Timestamp wins, regardless of where it sits in the
  // sheet. A row whose timestamp can't be parsed is treated as oldest
  // (loses any tie against a row with a real timestamp), and when
  // timestamps are exactly equal (or both unparseable) the later row in
  // sheet order still wins.
  //
  // Legacy rows (from the separate LEGACY_CSV_URL feed, see below) are
  // handled in a second pass further down: they NEVER compete on
  // timestamp against a row from the main sheet for the same identity,
  // because a legacy row's stamped date (its old Wix "created" date) has
  // no reliable relationship to how current the matching live entry
  // actually is. A legacy row only ever fills a gap where no current
  // entry exists at all for that person.
  const byIdentity = new Map();

  for (const r of rows) {
    const firstName = clean(r[COL.firstName]);
    const lastName = clean(r[COL.lastName]);
    const organization = clean(r[COL.organization]);
    if (!firstName && !lastName && !organization) continue; // skip blank rows

    const publishFlag = String(r[COL.publish] || "").trim().toUpperCase();
    if (publishFlag !== "X") continue; // only show rows marked ready

    const identityKey = ((firstName + " " + lastName).trim() || organization).toLowerCase();

    const parsedTs = Date.parse(r[COL.timestamp]);
    const rowTimestamp = Number.isNaN(parsedTs) ? -Infinity : parsedTs;

    const existing = byIdentity.get(identityKey);
    if (existing && rowTimestamp < existing._timestamp) {
      continue; // an already-stored row is strictly newer; keep it
    }

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
      isLegacy: false,
      _timestamp: rowTimestamp,
      _rand: Math.random()
    });
  }

  // Second pass: rows from the separate legacy feed only ever fill
  // identities with no current entry. Among legacy rows competing for the
  // same still-open identity, the latest-timestamped one wins (same
  // tie-break logic as above). Legacy entries always display as
  // "Waitlist Available" regardless of whatever accepting status was in
  // the old Wix data -- that field is too stale to trust -- and are
  // flagged isLegacy so they sort below current entries within the same
  // tier instead of "rising to the top."
  // Past the cutoff date, skip the legacy feed entirely -- don't even
  // parse it, just treat it as if it returned nothing.
  const legacyRows = Date.now() >= LEGACY_CUTOFF_DATE.getTime()
    ? []
    : parseCSV(legacyText).filter(r => r.length > 1);
  if (legacyRows.length) legacyRows.shift(); // drop header row, if present

  for (const r of legacyRows) {
    const firstName = clean(r[COL.firstName]);
    const lastName = clean(r[COL.lastName]);
    const organization = clean(r[COL.organization]);
    const identityKey = ((firstName + " " + lastName).trim() || organization).toLowerCase();

    if (byIdentity.has(identityKey) && !byIdentity.get(identityKey).isLegacy) continue;

    const parsedTs = Date.parse(r[COL.timestamp]);
    const rowTimestamp = Number.isNaN(parsedTs) ? -Infinity : parsedTs;

    const existingLegacy = byIdentity.get(identityKey);
    if (existingLegacy && rowTimestamp < existingLegacy._timestamp) continue;

    byIdentity.set(identityKey, {
      firstName,
      lastName,
      organization,
      credentials: clean(r[COL.credentials]),
      email: clean(r[COL.email]),
      phone: clean(r[COL.phone]),
      website: clean(r[COL.website]),
      accepting: "Waitlist Available",
      format: clean(r[COL.format]),
      location: clean(r[COL.location]),
      specialties: clean(r[COL.specialties]),
      approaches: clean(r[COL.approaches]),
      insurance: clean(r[COL.insurance]),
      gender: clean(r[COL.gender]),
      ageGroups: clean(r[COL.ageGroups]),
      languages: clean(r[COL.languages]),
      isLegacy: true,
      _timestamp: rowTimestamp,
      _rand: Math.random()
    });
  }

  const providers = Array.from(byIdentity.values());

  applyAttestations(providers, attestationText);
  return providers;
}

// Applies the "still accepting?" attestation responses (already fetched
// as plain text -- see the Promise.all in loadData) to each provider
// matched by name, either refreshing their accepting status (if they
// attested within the last ATTESTATION_STALE_DAYS) or bumping them to
// "Waitlist Available" (if too much time has passed since their last
// attestation -- or since BOOTSTRAP_ATTESTATION_DATE, for someone who's
// never attested at all). Reminder emails go out once a quarter, but the
// staleness math itself is a rolling 100 days per person, not tied to
// quarters. An empty/unreachable attestation feed (fetchTextOrEmpty
// already swallowed that error) just means nothing here changes.
function applyAttestations(providers, attestationText) {
  const rows = parseCSV(attestationText).filter(r => r.length > 1);
  if (!rows.length) return;
  rows.shift(); // drop header row

  const latestByName = new Map();
  for (const r of rows) {
    const name = normalizeName((clean(r[1]) + " " + clean(r[2])).trim());
    if (!name) continue;
    const ts = Date.parse(r[0]);
    const timestamp = Number.isNaN(ts) ? -Infinity : ts;
    const existing = latestByName.get(name);
    if (!existing || timestamp >= existing.timestamp) {
      latestByName.set(name, { timestamp, raw: clean(r[3]) });
    }
  }

  const now = Date.now();
  const staleMs = ATTESTATION_STALE_DAYS * 24 * 60 * 60 * 1000;
  const bootstrapTs = BOOTSTRAP_ATTESTATION_DATE.getTime();

  const WAITLIST_TIER = ACCEPTING_TIERS.indexOf("Waitlist Available");

  for (const p of providers) {
    // Organization-only listings (no individual first/last name) are
    // exempt from the whole attestation/staleness system -- there's no
    // name for them to attest under, and they were never expected to.
    // Whatever the main sheet says for them is trusted permanently.
    if (!p.firstName && !p.lastName) continue;

    const key = normalizeName((p.firstName + " " + p.lastName).trim());
    const attestation = latestByName.get(key);
    // The effective "last attested" timestamp: a real attestation if they
    // have one, otherwise BOOTSTRAP_ATTESTATION_DATE -- this is what lets
    // "never attested" and "attested a while ago" share one rolling
    // 100-day-staleness rule instead of two separate mechanisms. Before
    // the bootstrap date, (now - effectiveTs) is negative for anyone who
    // hasn't attested, so they're never treated as stale yet.
    const effectiveTs = attestation ? attestation.timestamp : bootstrapTs;

    // Staleness only ever pulls someone DOWN to "Waitlist Available" --
    // it never pulls someone UP. In ACCEPTING_TIERS, "Waitlist Available"
    // actually ranks BETTER than "By PCP Referral Only" and "No", so a
    // naive unconditional override would wrongly "promote" those two up
    // to Waitlist just because they haven't re-attested. A provider
    // already sitting at "No" or "By PCP Referral Only" stays exactly
    // there regardless of how stale their attestation is; only a genuine
    // new attestation (handled below) can move them off of it. Only
    // someone currently at "Yes" (strictly better than Waitlist) is
    // actually eligible to be pulled down.
    const eligibleForDemotion = acceptingTier(p.accepting) < WAITLIST_TIER;

    if (now - effectiveTs > staleMs) {
      if (eligibleForDemotion) p.accepting = "Waitlist Available";
      continue;
    }

    if (!attestation) continue; // not stale yet, nothing to apply

    // A real, recent attestation proves this person is actually active --
    // even if they were originally a legacy-import entry, stop treating
    // them as a stale legacy record for sorting purposes.
    p.isLegacy = false;

    const checked = splitExact(attestation.raw);
    if (!checked.length) continue;
    const resolved = ATTESTATION_CONFLICT_PRIORITY.find(tier =>
      checked.some(c => c.toLowerCase() === tier.toLowerCase())
    );
    if (resolved) p.accepting = resolved;
  }
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
  fillSelect(document.getElementById("f-format"), FORMAT_FILTER_OPTIONS, "Telehealth / In-person: Any");
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
    if (format && !matchesFormat(it.format, format)) return false;
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
    // Within the same accepting tier, legacy-import entries (unresponsive
    // to repeated requests to confirm their info) sort after everyone
    // else instead of mixing in randomly.
    if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1;
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
