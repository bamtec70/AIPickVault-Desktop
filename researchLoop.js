"use strict";

const {
  shouldUseKnowledgeFirst,
  domainPackPromptSection,
  loadGigVehicleDomainPack,
  isLocateRecommendedVehicleAsk,
  isPackBackedLocateAsk,
  isYearRecallAsk,
  isGigVehicleDomainAsk,
  isPlatformEligibilityAsk,
  platformEligibilitySearchQueries,
  VEHICLE_LISTING_MODELS,
  VEHICLE_MAKES
} = require("./domain/gigVehicle");
const {
  OFFICIAL_POLICY_HOSTS
} = require("./domain/platformEligibility");
const { needsFactualRefresh } = require("./router");
const { listingSearchQueryFromUrl, isListingSiteUrl } = require("./tools");

/**
 * Multi-step research agent loop for AIPickVault Desktop.
 *
 * planTools(route, message) -> ordered steps (1–3)
 * runResearchLoop(...)      -> execute tools â†’ synthesize cited answer
 */

const MAX_STEPS = 3;

const PREFERRED_RESEARCH_HOSTS = [
  "edmunds.com", "kbb.com", "consumerreports.org", "repairpal.com",
  "fuelly.com", "fueleconomy.gov", "reddit.com", "cars.com",
  "cargurus.com", "autotrader.com", "carvana.com", "iihs.org",
  "nhtsa.gov", "yourmechanic.com", "aaa.com", "bankrate.com", "nerdwallet.com"
];

const DEMOTED_RESEARCH_HOSTS = [
  "play.google.com", "apps.apple.com", "appstore", "apkpure",
  "apkcombo", "uptodown.com", "softonic.com", "download.", "getapp.com"
];

function extractBudget(message) {
  const raw = String(message || "");
  const patterns = [
    /\$\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
    /\bunder\s+\$?\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
    /\bbelow\s+\$?\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
    /\bless\s+than\s+\$?\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
    /\bmax(?:imum)?\s+(?:price\s+)?\$?\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
    /\bunder\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bbelow\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bless\s+than\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bmax(?:imum)?\s+(?:price\s+)?\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)\s*(?:or\s+less)?\b/,
    /\b([\d,]+)\s*k\s*(?:budget|max|maximum|or\s+less)?\b/i,
    /\bbudget\s+(?:of\s+|under\s+|is\s+)?\$?\s*([\d,]+(?:\.\d+)?)\s*k?\b/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    let n = parseFloat(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/k\b/i.test(m[0])) n = Math.round(n * 1000);
    if (n >= 100) return Math.round(n);
  }
  return null;
}

function extractGigUseCase(message) {
  const lower = String(message || "").toLowerCase();
  const platforms = [];
  if (/\blyft\b/.test(lower)) platforms.push("Lyft");
  if (/\bdoordash\b|\bdoor\s*dash\b/.test(lower)) platforms.push("DoorDash");
  if (/\buber\s*eats\b/.test(lower)) platforms.push("Uber Eats");
  else if (/\buber\b/.test(lower)) platforms.push("Uber");
  if (/\broadie\b/.test(lower)) platforms.push("Roadie");
  if (/\binstacart\b/.test(lower)) platforms.push("Instacart");
  if (/\bgrubhub\b/.test(lower)) platforms.push("Grubhub");
  if (/\bamazon\s+flex\b/.test(lower)) platforms.push("Amazon Flex");
  const isGig =
    platforms.length > 0 ||
    /\b(gig\s+delivery|last\s*mile|food\s+delivery|courier|rideshare|ride[\s-]?share)\b/.test(lower);
  return {
    isGig,
    platforms,
    label: platforms.length ? platforms.join(" ") : isGig ? "gig delivery" : null
  };
}

function extractCriteria(message) {
  const lower = String(message || "").toLowerCase();
  return {
    annualCost: /\b(annual\s+cost|cost\s+of\s+ownership|overall\s+(?:annual\s+)?cost|running\s+cost|cost\s+to\s+run|tco)\b/.test(lower),
    reliability: /\breliab/.test(lower),
    maintenance: /\b(maintenance|repair|parts)\b/.test(lower),
    fuel: /\b(fuel|mpg|gas\s+mile|mileage|efficiency)\b/.test(lower),
    insurance: /\binsurance\b/.test(lower),
    tires: /\btires?\b/.test(lower)
  };
}

function hasCostReliabilityLanguage(message) {
  const c = extractCriteria(message);
  return c.annualCost || c.reliability || c.maintenance || c.fuel || c.insurance || c.tires;
}

function isVehicleAsk(message) {
  const text = String(message || "");
  return /\b(car|truck|suv|vehicle|hybrid|sedan|hatchback|minivan|pickup|civic|corolla|prius|camry|accord|cargo\s+van|van|f[- ]?150)\b/i.test(text)
    || VEHICLE_LISTING_MODELS.test(text)
    || VEHICLE_MAKES.test(text);
}

const MODEL_MAKE_TABLE = [
  { re: /\b(corollas?|corrolas?|carollas?|corrollas?)\b/i, model: "Corolla", make: "Toyota", packYears: "2010-2015", packTrim: "LE SE" },
  { re: /\b(prius(?:es)?)\b/i, model: "Prius", make: "Toyota", packYears: "2010-2015" },
  { re: /\b(civics?)\b/i, model: "Civic", make: "Honda" },
  { re: /\b(camrys?)\b/i, model: "Camry", make: "Toyota" },
  { re: /\b(accords?)\b/i, model: "Accord", make: "Honda" },
  { re: /\b(rav4s?)\b/i, model: "RAV4", make: "Toyota" },
  { re: /\b(cr[- ]?vs?)\b/i, model: "CR-V", make: "Honda" },
  { re: /\b(f[- ]?150s?)\b/i, model: "F-150", make: "Ford" },
  { re: /\b(f[- ]?250s?)\b/i, model: "F-250", make: "Ford" },
  { re: /\b(silverados?)\b/i, model: "Silverado", make: "Chevrolet" },
  { re: /\b(tacomas?)\b/i, model: "Tacoma", make: "Toyota" },
  { re: /\b(tundras?)\b/i, model: "Tundra", make: "Toyota" },
  { re: /\b(altimas?)\b/i, model: "Altima", make: "Nissan" },
  { re: /\b(sentras?)\b/i, model: "Sentra", make: "Nissan" },
  { re: /\b(elantras?)\b/i, model: "Elantra", make: "Hyundai" },
  { re: /\b(outbacks?)\b/i, model: "Outback", make: "Subaru" },
  { re: /\b(wranglers?)\b/i, model: "Wrangler", make: "Jeep" },
  { re: /\b(mustangs?)\b/i, model: "Mustang", make: "Ford" },
  { re: /\b(siennas?)\b/i, model: "Sienna", make: "Toyota" },
  { re: /\b(odysseys?)\b/i, model: "Odyssey", make: "Honda" },
  { re: /\b(yaris(?:es)?)\b/i, model: "Yaris", make: "Toyota" },
  { re: /\b(fits?)\b/i, model: "Fit", make: "Honda" }
];

const MAKE_CANON = [
  { re: /\b(toyota)\b/i, make: "Toyota" },
  { re: /\b(honda)\b/i, make: "Honda" },
  { re: /\b(ford)\b/i, make: "Ford" },
  { re: /\b(chevrolet|chevy)\b/i, make: "Chevrolet" },
  { re: /\b(gmc)\b/i, make: "GMC" },
  { re: /\b(nissan)\b/i, make: "Nissan" },
  { re: /\b(hyundai)\b/i, make: "Hyundai" },
  { re: /\b(kia)\b/i, make: "Kia" },
  { re: /\b(mazda)\b/i, make: "Mazda" },
  { re: /\b(subaru)\b/i, make: "Subaru" },
  { re: /\b(jeep)\b/i, make: "Jeep" },
  { re: /\b(ram)\b/i, make: "Ram" },
  { re: /\b(dodge)\b/i, make: "Dodge" },
  { re: /\b(lexus)\b/i, make: "Lexus" },
  { re: /\b(acura)\b/i, make: "Acura" },
  { re: /\b(tesla)\b/i, make: "Tesla" },
  { re: /\b(volkswagen|vw)\b/i, make: "Volkswagen" },
  { re: /\b(bmw)\b/i, make: "BMW" }
];

/**
 * Extract make/model/years/trim/budget/location for any vehicle listing ask.
 * Defaults location to Fort Worth / 76177 only when user omits one.
 * Corolla/Prius pack years apply when user named those models (or pack-backed locate) and gave no years.
 */
function extractVehicleListingSpec(message, opts) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const budget = extractBudget(text);
  let make = null;
  let model = null;
  let packYears = null;
  let packTrim = null;

  for (const row of MODEL_MAKE_TABLE) {
    if (row.re.test(text)) {
      model = row.model;
      make = row.make;
      packYears = row.packYears || null;
      packTrim = row.packTrim || null;
      break;
    }
  }
  if (!make) {
    for (const row of MAKE_CANON) {
      if (row.re.test(text)) {
        make = row.make;
        break;
      }
    }
  }

  let years = null;
  const range = text.match(/\b(19\d{2}|20\d{2})\s*[-–—to]+\s*(19\d{2}|20\d{2})\b/i);
  if (range) {
    years = range[1] + "-" + range[2];
  } else {
    const singles = [];
    const reY = /\b(19\d{2}|20\d{2})\b/g;
    let m;
    while ((m = reY.exec(text)) !== null) {
      const y = parseInt(m[1], 10);
      if (y >= 1990 && y <= 2030) singles.push(String(y));
    }
    if (singles.length === 1) years = singles[0];
    else if (singles.length >= 2) years = singles[0] + "-" + singles[1];
  }

  let trim = null;
  const trimM = text.match(/\b(LE|SE|XLE|XSE|EX|LX|DX|Sport|Limited|Touring|Hybrid|TRD|Lariat|XLT|King Ranch|Platinum|S|SV|SL)\b/);
  if (trimM) trim = trimM[1];

  let city = null;
  let zip = null;
  const zipM = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipM) zip = zipM[1];
  if (/\bfort\s*worth\b/i.test(text)) city = "Fort Worth";
  else if (/\bdallas\b/i.test(text)) city = "Dallas";
  else if (/\barlington\b/i.test(text)) city = "Arlington";
  else if (/\balliance\b/i.test(text)) city = "Alliance";

  if (!city && !zip) {
    city = "Fort Worth";
    zip = "76177";
  } else if (city && !zip && /fort worth|alliance/i.test(city)) {
    zip = "76177";
  } else if (zip === "76177" && !city) {
    city = "Fort Worth";
  }

  const packBacked = !!(opts && opts.packBacked) || isPackBackedLocateAsk(text);
  const namedCorollaPrius = /\b(corollas?|corrolas?|carollas?|corrollas?|prius(?:es)?)\b/i.test(text);
  if (!years && packYears && (packBacked || namedCorollaPrius)) {
    years = packYears;
  }
  if (!trim && packTrim && (packBacked || namedCorollaPrius) && /corolla/i.test(model || "")) {
    trim = packTrim;
  }

  // Pack-backed locate with no model named → Corolla default
  if (!model && packBacked) {
    model = "Corolla";
    make = make || "Toyota";
    if (!years) years = "2010-2015";
    if (!trim) trim = "LE SE";
  }

  return {
    make,
    model,
    years,
    trim,
    budget,
    location: { city: city || "Fort Worth", zip: zip || "76177" },
    packBacked
  };
}

/**
 * Shared listing-query builder for any vehicle locate / under-budget search.
 */
function buildVehicleListingQueries(spec) {
  const s = spec || {};
  const make = s.make || null;
  const model = s.model || "used car";
  const years = s.years || null;
  const trim = s.trim || null;
  const budget = s.budget != null ? s.budget : null;
  const city = (s.location && s.location.city) || "Fort Worth";
  const zip = (s.location && s.location.zip) || "76177";
  const yearSite = years ? String(years).replace(/-/g, "..") : null;
  const head = [years, make, model, trim].filter(Boolean).join(" ");
  const headNoTrim = [years, make, model].filter(Boolean).join(" ");
  const queries = [];

  if (budget != null) {
    queries.push([head, "under", String(budget), "for sale", city].filter(Boolean).join(" "));
    queries.push(
      ["site:autotrader.com", make, model, yearSite || years, "price under", String(budget), zip]
        .filter(Boolean)
        .join(" ")
    );
    queries.push(
      ["site:cars.com", headNoTrim || model, "under", String(budget), city].filter(Boolean).join(" ")
    );
  } else {
    queries.push([head, "for sale", city, zip].filter(Boolean).join(" "));
    queries.push(
      ["site:autotrader.com", make, model, years, "near", zip].filter(Boolean).join(" ")
    );
    queries.push(
      ["site:cars.com", make, model, years, "used", city].filter(Boolean).join(" ")
    );
  }
  return queries.map((q) => String(q).replace(/\s+/g, " ").trim()).filter(Boolean);
}


/**
 * Intent-based rewrite — NOT naive stopword deletion.
 * Emits 2–3 tight US-focused queries when recommendation + gig/budget.
 */
function rewriteSearchQuery(message, opts) {
  const wantsRec = !!(opts && opts.wantsRecommendation);
  const raw = String(message || "").trim();
  if (!raw) {
    return {
      primary: "", alternate: null, tertiary: null, queries: [],
      rewritten: false, budget: null,
      gig: { isGig: false, platforms: [], label: null },
      criteria: extractCriteria("")
    };
  }

  let text = raw
    .replace(/^(search\s+for|search|look\s*up|lookup|find|google)\s+/i, "")
    .trim();

  const budget = extractBudget(text);
  const gig = extractGigUseCase(text);
  const criteria = extractCriteria(text);
  const vehicle = isVehicleAsk(text);
  const budgetPhrase = budget != null ? `under ${budget}` : null;

  const looksLikeEssay =
    raw.length > 60 ||
    /\b(what(?:'s| is)|which|how (?:do|to|can)|should i|i need|i'?m looking)\b/i.test(raw) ||
    wantsRec;

  const queries = [];

  // Any-vehicle locate / find / for-sale / under-budget listing search (preserve budget)
  if (isLocateRecommendedVehicleAsk(raw) || isLocateRecommendedVehicleAsk(text)) {
    const spec = extractVehicleListingSpec(raw || text, {
      packBacked: isPackBackedLocateAsk(raw) || isPackBackedLocateAsk(text)
    });
    if (budget != null) spec.budget = budget;
    for (const q of buildVehicleListingQueries(spec)) queries.push(q);
  }

  // Platform eligibility / vehicle age — official help searches (never pack-only)
  if (isPlatformEligibilityAsk(raw) || isPlatformEligibilityAsk(text) || (opts && opts.platformEligibility)) {
    for (const q of platformEligibilitySearchQueries(raw || text)) queries.push(q);
  }

  // Recall / NHTSA / battery follow-ups — tight factual queries first
  if (/\b(recall|nhtsa)\b/i.test(text) || (/\bbattery\b/i.test(text) && /\b(prius|toyota|hybrid|generation)\b/i.test(text))) {
    const modelBit = (text.match(/\b(prius|corolla|civic|camry|accord|rav4|sienna)\b/i) || [])[0] || "used car";
    queries.push(`${modelBit} hybrid battery recall NHTSA`);
    queries.push(`${modelBit} generations years battery recall affected`);
    if (/\bgeneration\b/i.test(text)) {
      queries.push(`Toyota Prius gen 2 gen 3 gen 4 hybrid battery reliability`);
    }
  }

  const didListingLocate = queries.length > 0 && (isLocateRecommendedVehicleAsk(raw) || isLocateRecommendedVehicleAsk(text));
  if ((wantsRec || looksLikeEssay) && (vehicle || gig.isGig) && (!didListingLocate || gig.isGig)) {
    const platformBit =
      gig.label && (gig.label.includes("DoorDash") || gig.label.includes("Uber"))
        ? "DoorDash Uber"
        : gig.label || "DoorDash Uber";
    queries.push(
      ["best used cars for", platformBit, budgetPhrase || "cheap"].filter(Boolean).join(" ")
    );
    queries.push("highest mileage reliable used cars low maintenance cost");
    if (criteria.annualCost || criteria.fuel || criteria.insurance || wantsRec) {
      queries.push("used car cost of ownership fuel insurance maintenance delivery driver");
    } else {
      queries.push(["reliable cheap used gig delivery cars", budgetPhrase].filter(Boolean).join(" "));
    }
  } else if ((wantsRec || looksLikeEssay) && /\b(laptop|phone|headphones?|tv|camera|router)\b/i.test(text)) {
    const product = (text.match(/\b(laptop|phone|headphones?|tv|camera|router)\b/i) || [])[0] || "product";
    queries.push(["best", "budget", product, budgetPhrase, "US"].filter(Boolean).join(" "));
    queries.push(`reliable affordable used ${product} reviews`);
    if (budgetPhrase) queries.push(`${product} under ${budget} cost of ownership`);
  } else if (wantsRec || looksLikeEssay) {
    const drop = /^(since|drive|looking|know|need|want|thats|that|this|with|from|have|has|been|were|into|about|other|along|overall|platforms|vehicle|the|and|for|are|but|not|you|all|can|was|one|our|out|get|how|new|now|old|see|two|way|who|any|ask|big|few|got|had|may|own|try|just|like|make|more|only|over|some|than|them|then|what|when|will|your|also|really|very|please|tell|give|find|show|each|every|both|most|such|same|too|should|would|could|shall|might|must|using|used|im|i)$/i;
    const nounish = text
      .replace(/[?!.,;:]+/g, " ")
      .split(/\s+/)
      .filter((tok) => {
        const lower = tok.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
        if (!lower || lower.length < 3) return false;
        if (drop.test(lower)) return false;
        return /^[a-zA-Z]/.test(lower);
      })
      .slice(0, 8);
    const primaryGeneric = [( /\bbest\b/i.test(text) ? "best" : null), ...nounish, budgetPhrase]
      .filter(Boolean).join(" ").trim();
    queries.push(primaryGeneric || text.slice(0, 80));
    if (wantsRec) queries.push(`best options ${primaryGeneric || text.slice(0, 60)}`.slice(0, 100));
  } else {
    queries.push(text.replace(/[?!.,;:]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100));
  }

  const seen = new Set();
  const deduped = [];
  for (let q of queries) {
    q = String(q || "").replace(/\s+/g, " ").trim();
    if (!q) continue;
    if (q.split(/\s+/).length > 14) q = q.split(/\s+/).slice(0, 14).join(" ");
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(q);
  }
  if (!deduped.length) deduped.push(raw.slice(0, 100));

  return {
    primary: deduped[0],
    alternate: deduped[1] || null,
    tertiary: deduped[2] || null,
    queries: deduped,
    rewritten: looksLikeEssay || deduped[0].toLowerCase() !== raw.toLowerCase() || !!deduped[1],
    budget,
    gig,
    criteria
  };
}

function rewriteNewsTopic(topic) {
  const { primary } = rewriteSearchQuery(String(topic || ""), { wantsRecommendation: false });
  return primary || String(topic || "").trim();
}

function scoreWebResultForSynth(result) {
  const link = String((result && (result.link || result.url)) || "").toLowerCase();
  const title = String((result && result.title) || "").toLowerCase();
  const snippet = String((result && result.snippet) || "").toLowerCase();
  const blob = `${link} ${title} ${snippet}`;
  let score = 0;
  for (const host of PREFERRED_RESEARCH_HOSTS) {
    if (link.includes(host)) { score += 8; break; }
  }
  for (const host of OFFICIAL_POLICY_HOSTS) {
    if (link.includes(host)) { score += 12; break; }
  }
  if (/reddit\.com\/r\/(doordash|uber|couriers|gigworkers|cars|whatcarshouldibuy)/i.test(link)) score += 4;
  for (const bad of DEMOTED_RESEARCH_HOSTS) {
    if (link.includes(bad) || title.includes(bad)) { score -= 12; break; }
  }
  if (/\b(uae|dubai|india apk|play store|app store|download apk)\b/i.test(blob)) score -= 10;
  if (/\b(toyota|honda|corolla|civic|prius|camry|accord|used car|mpg|reliability|maintenance|ownership)\b/i.test(blob)) score += 3;
  if (/\b(doordash|uber|gig|delivery driver)\b/i.test(blob)) score += 2;
  return score;
}

function rankWebResultsForSynth(results) {
  if (!Array.isArray(results) || !results.length) return results || [];
  return results
    .map((r, i) => ({ r, i, s: scoreWebResultForSynth(r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}

function resultsSeemThinOrOffTopic(webResults, message, query) {
  if (!Array.isArray(webResults) || webResults.length === 0) return true;
  if (webResults.length < 3) return true;
  const lowerMsg = String(message || "").toLowerCase();
  const constraintHints = [];
  const budget = extractBudget(lowerMsg);
  if (budget) constraintHints.push(String(budget), "under");
  if (/\bdoordash\b/i.test(lowerMsg)) constraintHints.push("doordash", "delivery");
  if (/\buber\b/i.test(lowerMsg)) constraintHints.push("uber", "delivery");
  if (/\b(car|truck|suv|vehicle)\b/i.test(lowerMsg)) {
    constraintHints.push("car", "cars", "vehicle", "used", "toyota", "honda", "ford", "hybrid");
  }
  const blob = webResults.map((r) => `${r.title || ""} ${r.snippet || ""} ${(r.link || r.url || "")}`).join(" ").toLowerCase();
  const spamHits = webResults.filter((r) => scoreWebResultForSynth(r) < -5).length;
  if (spamHits >= Math.ceil(webResults.length * 0.6)) return true;
  if (constraintHints.length === 0) {
    const qWords = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (!qWords.length) return false;
    return qWords.filter((w) => blob.includes(w)).length < Math.min(2, qWords.length);
  }
  const luxuryNoise =
    /\b(highlander|lexus|es\s*300|mercedes|bmw|cadillac|range rover)\b/i.test(blob) &&
    !/\bunder\s*\$?\s*10|\$\s*[1-9]\d{3}\b|\bcheap\b|\bbudget\b|\bused\b/i.test(blob);
  let topicHits = 0;
  for (const h of constraintHints) {
    if (blob.includes(String(h).toLowerCase())) topicHits += 1;
  }
  if (luxuryNoise && budget) return true;
  if (topicHits < 2 && webResults.length <= 5) return true;
  return false;
}

function planTools(route, message) {
  const intent = route && route.intent ? route.intent : "chat";
  const payload = (route && route.payload) || {};
  const toolsHint = Array.isArray(payload.tools) ? payload.tools : [];
  const text = String(message || "").trim();
  const wantsRec = !!payload.wantsRecommendation;
  const steps = [];

  if (intent === "chat") return [];

  if (intent === "weather") {
    steps.push({ id: "weather", tool: "weather", label: "Weather", args: { location: payload.location || "Fort Worth" } });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "fetch") {
    const url = payload.url || (Array.isArray(payload.urls) && payload.urls[0]) || null;
    steps.push({
      id: "fetch",
      tool: "fetch",
      label: "Fetch webpage",
      args: { url }
    });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "news") {
    steps.push({ id: "news", tool: "news", label: "News", args: { topic: rewriteNewsTopic(payload.topic || "technology") } });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "search") {
    const rawQuery = payload.query || text;
    const rewritten = rewriteSearchQuery(rawQuery, { wantsRecommendation: wantsRec });
    const queryList = rewritten.queries.length ? rewritten.queries.slice() : [rewritten.primary || rawQuery];
    const costRel = hasCostReliabilityLanguage(rawQuery) || hasCostReliabilityLanguage(text);
    const forceRefresh = !!payload.forceToolRefresh || needsFactualRefresh(text);
    const knowledgeFirst = shouldUseKnowledgeFirst(text, route) || shouldUseKnowledgeFirst(rawQuery, route);
    // Knowledge-first: general gig/vehicle advice uses local domain pack — no multi-search blast.
    // Verification (recall/NHTSA/price/listing/insurance) still forces tools below.
    const eligibilityAsk =
      isPlatformEligibilityAsk(text) ||
      isPlatformEligibilityAsk(rawQuery) ||
      !!payload.platformEligibility;
    const forceRefreshEffective = forceRefresh || eligibilityAsk;
    // Hard gate: platform age/eligibility CANNOT complete pack-only
    if (knowledgeFirst && !forceRefreshEffective && !eligibilityAsk) {
      return [{
        id: "domain",
        tool: "domain",
        label: "Gig-vehicle domain pack",
        args: {},
        knowledgeFirst: true
      }];
    }
    if (eligibilityAsk) {
      const eq = platformEligibilitySearchQueries(rawQuery || text);
      for (let qi = 0; qi < Math.min(eq.length, 2) && steps.length < MAX_STEPS; qi++) {
        steps.push({
          id: qi === 0 ? "search" : "search" + (qi + 1),
          tool: "search",
          label: qi === 0 ? "Web search (platform policy)" : "Web search (platform policy " + (qi + 1) + ")",
          args: { query: eq[qi] },
          mergeWeb: qi > 0,
          queryMeta: { original: rawQuery, rewritten: eq[qi], wasRewritten: true, platformEligibility: true }
        });
      }
      // Prefer fetching top official URL later via search results; keep plan search-first
    }
    // Pack-backed locate (recommended Corolla/Prius / gig): pack + listing search.
    // Generic Civic/F-150 listing locate skips pack — search tools only.
    if (
      isPackBackedLocateAsk(text) ||
      isPackBackedLocateAsk(rawQuery) ||
      payload.packBackedLocate
    ) {
      steps.push({
        id: "domain",
        tool: "domain",
        label: "Gig-vehicle domain pack",
        args: {},
        knowledgeFirst: false
      });
    }
    const locateListing = isLocateRecommendedVehicleAsk(text) || isLocateRecommendedVehicleAsk(rawQuery) || !!payload.locateRecommendedVehicle;
    const multiAngle = !knowledgeFirst && (wantsRec || locateListing) && (costRel || rewritten.gig.isGig || isVehicleAsk(rawQuery) || locateListing);

    if (toolsHint.includes("search") || toolsHint.length === 0 || locateListing) {
      const primary = queryList[0] || rawQuery;
      const already = steps.some((s) => s.tool === "search" && String(s.args && s.args.query || "").toLowerCase() === String(primary).toLowerCase());
      if (!already) {
        steps.push({
          id: steps.some((s) => s.tool === "search") ? "search_extra" : "search",
          tool: "search", label: "Web search",
          args: { query: primary },
          mergeWeb: steps.some((s) => s.tool === "search"),
          queryMeta: { original: rawQuery, rewritten: primary, wasRewritten: rewritten.rewritten }
        });
      }
    }

    if ((wantsRec || locateListing) && steps.some((s) => s.tool === "search")) {
      const secondQ = queryList[1] || rewritten.alternate;
      if (secondQ && secondQ.toLowerCase() !== String(steps[0].args.query).toLowerCase()) {
        steps.push({
          id: "search2", tool: "search", label: "Web search (reliability)",
          args: { query: secondQ }, mergeWeb: true,
          queryMeta: { original: rawQuery, rewritten: secondQ, wasRewritten: true }
        });
      }
      if (multiAngle && steps.length < MAX_STEPS) {
        const thirdQ = queryList[2] || rewritten.tertiary;
        if (thirdQ && !steps.some((s) => s.tool === "search" && String(s.args.query).toLowerCase() === thirdQ.toLowerCase())) {
          steps.push({
            id: "search3", tool: "search", label: "Web search (ownership cost)",
            args: { query: thirdQ }, mergeWeb: true,
            queryMeta: { original: rawQuery, rewritten: thirdQ, wasRewritten: true }
          });
        } else if (!toolsHint.includes("news") && steps.length < MAX_STEPS) {
          steps.push({
            id: "news", tool: "news", label: "News",
            args: { topic: rewriteNewsTopic(rewritten.gig.isGig ? "used cars gig delivery drivers US" : secondQ || queryList[0]) },
            refineFrom: "search"
          });
        }
      }
    }

    if (toolsHint.includes("news") && !steps.some((s) => s.tool === "news") && steps.length < MAX_STEPS) {
      steps.push({
        id: "news", tool: "news", label: "News",
        args: { topic: rewriteNewsTopic(rewritten.alternate && wantsRec ? rewritten.alternate : queryList[0]) },
        refineFrom: "search"
      });
    }

    const minSteps = multiAngle ? 3 : (wantsRec || locateListing) ? 2 : 1;
    while ((wantsRec || locateListing) && steps.length < minSteps && steps.length < MAX_STEPS && steps.some((s) => s.tool === "search")) {
      const fallbackQ =
        queryList[steps.filter((s) => s.tool === "search").length] ||
        rewritten.alternate ||
        `best options ${queryList[0]}`.slice(0, 100);
      if (!fallbackQ || steps.some((s) => s.tool === "search" && String(s.args.query).toLowerCase() === fallbackQ.toLowerCase())) break;
      steps.push({
        id: `search${steps.filter((s) => s.tool === "search").length + 1}`,
        tool: "search", label: "Web search (refined)",
        args: { query: fallbackQ }, mergeWeb: true
      });
    }

    // Dedupe search queries (eligibility + rewrite often overlap)
    {
      const seenQ = new Set();
      const deduped = [];
      for (const st of steps) {
        if (st.tool === "search") {
          const key = String(st.args && st.args.query || "").toLowerCase();
          if (seenQ.has(key)) continue;
          seenQ.add(key);
        }
        deduped.push(st);
      }
      steps.length = 0;
      steps.push(...deduped);
    }

    if ((toolsHint.includes("stock") || payload.optionalSymbol) && steps.length < MAX_STEPS) {
      steps.push({ id: "stock", tool: "stock", label: "Finance", args: { symbol: payload.optionalSymbol || payload.symbol } });
    }
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "stock") {
    const symbol = payload.symbol;
    if (symbol) steps.push({ id: "stock", tool: "stock", label: "Finance", args: { symbol } });
    if (toolsHint.includes("news") || symbol) {
      steps.push({ id: "news", tool: "news", label: "News", args: { topic: symbol || rewriteNewsTopic(text) } });
    }
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "stock_compare") {
    const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    const [s1, s2] = symbols;
    if (s1) steps.push({ id: "stock1", tool: "stock", label: `Finance (${s1})`, args: { symbol: s1 }, parallelGroup: "quotes" });
    if (s2) steps.push({ id: "stock2", tool: "stock", label: `Finance (${s2})`, args: { symbol: s2 }, parallelGroup: "quotes" });
    if (s1 && s2) steps.push({ id: "news", tool: "news", label: "News", args: { topic: `${s1} ${s2}` } });
    return steps.slice(0, MAX_STEPS);
  }

  return [];
}

function formatWebResults(results) {
  if (!Array.isArray(results) || results.length === 0) return "(none)";
  return results.map((r, i) => {
    const title = r.title || "Untitled";
    const link = r.link || r.url || "";
    const snippet = r.snippet || "";
    return `${i + 1}. ${title}\n   Link: ${link}\n   Snippet: ${snippet}`;
  }).join("\n\n");
}

function formatNewsResults(news) {
  if (!Array.isArray(news) || news.length === 0) return "(none)";
  return news.map((a, i) => {
    const title = a.title || "Untitled";
    const source = a.source || "";
    const url = a.url || a.link || "";
    return `${i + 1}. ${title}\n   Source: ${source}\n   Link: ${url}`;
  }).join("\n\n");
}

function isToolError(result) {
  if (result == null) return true;
  if (result.error) return true;
  return false;
}

function asList(result) {
  return Array.isArray(result) ? result : [];
}

function refineNewsTopic(originalTopic, webResults) {
  const base = String(originalTopic || "").trim();
  if (!Array.isArray(webResults) || webResults.length === 0) return base;
  const first = webResults[0];
  const title = first && first.title ? String(first.title) : "";
  if (!title || title.length < 8) return base;
  const cleaned = title.replace(/[|\-–—].*$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (cleaned.length < 6) return base;
  if (base && !cleaned.toLowerCase().includes(base.toLowerCase().slice(0, 12))) {
    return `${base} ${cleaned}`.slice(0, 100);
  }
  return base;
}

function countCitations(bag) {
  let n = 0;
  if (Array.isArray(bag.web)) n += bag.web.length;
  if (Array.isArray(bag.news)) n += bag.news.length;
  return n;
}

function describePlan(steps) {
  if (!steps.length) return "No tools";
  return steps.map((s) => s.label).join(" â†’ ");
}

function dedupeWebResults(list) {
  const out = [];
  const seen = new Set();
  for (const r of list || []) {
    const key = String((r && (r.link || r.url || r.title)) || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function executeStep(step, toolFns) {
  const { tool, args } = step;
  try {
    if (tool === "domain") {
      return { ok: true, kind: "domain", data: loadGigVehicleDomainPack() };
    }
    if (tool === "search") {
      const result = await toolFns.webSearch(args.query);
      if (isToolError(result)) return { ok: false, kind: "web", data: [], error: result && result.error };
      return { ok: true, kind: "web", data: asList(result) };
    }
    if (tool === "news") {
      const result = await toolFns.getNews(args.topic);
      if (isToolError(result)) return { ok: false, kind: "news", data: [], error: result && result.error };
      return { ok: true, kind: "news", data: asList(result) };
    }
    if (tool === "stock") {
      if (!args.symbol) return { ok: false, kind: "stock", data: null, error: "No symbol" };
      const result = await toolFns.getStock(args.symbol);
      if (isToolError(result)) return { ok: false, kind: "stock", data: result, error: result && result.error };
      return { ok: true, kind: "stock", data: result, symbol: args.symbol };
    }
    if (tool === "fetch") {
      if (typeof toolFns.fetchWebpage !== "function") {
        return { ok: false, kind: "page", data: null, error: "fetchWebpage not available" };
      }
      const result = await toolFns.fetchWebpage(args.url);
      if (isToolError(result)) return { ok: false, kind: "page", data: result, error: result && result.error };
      return { ok: true, kind: "page", data: result };
    }
    if (tool === "weather") {
      const result = await toolFns.getWeather(args.location);
      if (isToolError(result)) return { ok: false, kind: "weather", data: result, error: result && result.error };
      return { ok: true, kind: "weather", data: result };
    }
    return { ok: false, kind: "unknown", data: null, error: `Unknown tool: ${tool}` };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { ok: false, kind: tool, data: tool === "stock" || tool === "weather" || tool === "fetch" ? null : [], error: msg };
  }
}

function mergeStepResult(bag, step, outcome) {
  if (outcome.kind === "domain") {
    bag.domainPack = outcome.data || loadGigVehicleDomainPack();
  } else if (outcome.kind === "web") {
    if (step.mergeWeb && Array.isArray(bag.web) && bag.web.length) {
      bag.web = dedupeWebResults(bag.web.concat(outcome.data || []));
    } else {
      bag.web = outcome.data || [];
    }
  } else if (outcome.kind === "news") {
    bag.news = outcome.data || [];
  } else if (outcome.kind === "stock") {
    bag.stocks = bag.stocks || {};
    const sym = outcome.symbol || (step.args && step.args.symbol) || "UNKNOWN";
    bag.stocks[sym] = outcome.data;
  } else if (outcome.kind === "page") {
    bag.page = outcome.data;
  } else if (outcome.kind === "weather") {
    bag.weather = outcome.data;
  }
  if (!outcome.ok && outcome.error) {
    bag.errors.push({ step: step.id, tool: step.tool, error: String(outcome.error) });
  }
}


function collectToolTextBlob(bag) {
  const parts = [];
  if (!bag) return "";
  if (Array.isArray(bag.web)) {
    for (const r of bag.web) {
      parts.push(r.title || "", r.snippet || "", r.link || r.url || "");
    }
  }
  if (Array.isArray(bag.news)) {
    for (const r of bag.news) {
      parts.push(r.title || "", r.snippet || "", r.link || r.url || "");
    }
  }
  if (bag.page) {
    parts.push(bag.page.title || "", bag.page.url || "", bag.page.finalUrl || "");
    if (bag.page.text) parts.push(String(bag.page.text).slice(0, 8000));
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Cheap local check: platform year cutoffs / official policy / insurance % claims
 * must be supported by tool text. Returns { ok, reason, needed }.
 */
function evaluateSelfVerify(draftText, bag) {
  const draft = String(draftText || "");
  const toolBlob = collectToolTextBlob(bag);
  const hasTools = toolBlob.replace(/\s+/g, "").length > 40;

  const platformPolicyClaim =
    /\b(lyft|uber(?:\s*eats)?|doordash)[\s\S]{0,120}\b(require|requires|required|allow|allows|eligible|eligibility|accept|accepts|vehicle\s+age|model\s+year|or\s+newer|or\s+older|manufactured)\b/i.test(draft) ||
    /\b(official\s+(?:lyft|uber|doordash)\s+(?:policy|site|help)|verified\s+via\s+(?:lyft|uber|doordash|official)|per\s+(?:lyft|uber|doordash)\s+(?:policy|help|rules?))\b/i.test(draft) ||
    /\b\d{1,2}-year-old\s+vehicle\b/i.test(draft) ||
    /\b(20\d{2}|19\d{2})\s*\+\b/.test(draft) && /\b(lyft|uber|doordash|vehicle|rideshare)\b/i.test(draft);

  const insuranceRateClaim =
    /\binsurance\b[\s\S]{0,50}\b\d{1,3}\s*%/.test(draft) ||
    /\b\d{1,3}\s*%[\s\S]{0,40}\binsurance\b/i.test(draft);

  if (!platformPolicyClaim && !insuranceRateClaim) {
    return { ok: true, needed: false, reason: "no_policy_claims", status: "PASS" };
  }

  if (!hasTools) {
    return { ok: false, needed: true, reason: "policy_claim_without_tools", status: "RETRY" };
  }

  if (platformPolicyClaim) {
    const years = [];
    const reY = /\b(19\d{2}|20\d{2})\b/g;
    let m;
    while ((m = reY.exec(draft)) !== null) years.push(m[1]);
    const ageWin = draft.match(/\b(\d{1,2})-year-old\b/i);
    const toolHasPolicy =
      /lyft|uber|doordash|help\.lyft|help\.uber|vehicle requirements|model year|or newer|year-old vehicle|driver information/i.test(toolBlob);
    let supported = false;
    if (toolHasPolicy) {
      if (years.some((y) => toolBlob.includes(y))) supported = true;
      if (ageWin && (toolBlob.includes(ageWin[1] + "-year") || toolBlob.includes(ageWin[1] + " year") || toolBlob.includes(ageWin[1] + "-year-old"))) {
        supported = true;
      }
      // Rolling window phrasing
      if (/\d{1,2}-year-old|or newer|model year/i.test(toolBlob) && /lyft|uber|vehicle/i.test(draft)) {
        if (years.some((y) => toolBlob.includes(y)) || ageWin) supported = supported || /\d{1,2}-year-old|or newer/i.test(toolBlob);
      }
    }
    if (!supported) {
      return { ok: false, needed: true, reason: "unsupported_platform_year_claim", status: "RETRY" };
    }
  }

  if (insuranceRateClaim) {
    const pct = draft.match(/insurance[\s\S]{0,50}(\d{1,3})\s*%/i) || draft.match(/(\d{1,3})\s*%[\s\S]{0,40}insurance/i);
    if (pct) {
      const n = pct[1];
      if (!toolBlob.includes(n + "%") && !toolBlob.includes(n + " percent") && !toolBlob.includes(n + " per cent")) {
        return { ok: false, needed: true, reason: "unsupported_insurance_rate", status: "RETRY" };
      }
    }
  }

  return { ok: true, needed: false, reason: "claims_supported", status: "PASS" };
}

function enforcePlatformEligibilityPlan(steps, message, route) {
  const text = String(message || "");
  const payload = (route && route.payload) || {};
  if (!isPlatformEligibilityAsk(text) && !payload.platformEligibility) return steps || [];
  const list = Array.isArray(steps) ? steps.slice() : [];
  const hasLive = list.some((s) => s.tool === "search" || s.tool === "fetch");
  const onlyDomain = list.length > 0 && list.every((s) => s.tool === "domain");
  if (hasLive && !onlyDomain) return list;
  const out = list.filter((s) => s.tool !== "domain");
  const eq = platformEligibilitySearchQueries(text);
  for (let qi = 0; qi < eq.length && out.length < MAX_STEPS; qi++) {
    out.push({
      id: qi === 0 ? "search" : "search_elig_" + (qi + 1),
      tool: "search",
      label: "Web search (platform policy gate)",
      args: { query: eq[qi] },
      mergeWeb: out.some((s) => s.tool === "search"),
      queryMeta: { original: text, rewritten: eq[qi], wasRewritten: true, platformEligibility: true }
    });
  }
  return out.length ? out : list;
}


function buildWeatherSynthesisPrompt(message, bag) {
  const parts = [];
  parts.push(`You are AIPickVault Desktop — a general local research assistant. Summarize the weather clearly for Blake.`);
  parts.push(`Hard rules:`);
  parts.push(`- Lead with current conditions and today's high/low.`);
  parts.push(`- Mention tomorrow if present.`);
  parts.push(`- Use ONLY the weather data below; do not invent numbers.`);
  parts.push(`- Do NOT claim you are a vehicle-only assistant. Do not mention cars, gig delivery, or domain packs.`);
  parts.push(`- No raw JSON. Short structured sections.`);
  if (Array.isArray(bag.lessons) && bag.lessons.length) {
    parts.push(``);
    parts.push(`Durable lessons (obey):`);
    for (const L of bag.lessons.slice(-10)) parts.push(`- ${L}`);
  }
  parts.push(``);
  parts.push(`User question:`);
  parts.push(message);
  parts.push(``);
  parts.push(`Intent: weather`);
  if (bag.weather) {
    parts.push(``);
    parts.push(`Weather data:`);
    parts.push(JSON.stringify(bag.weather, null, 2));
  }
  if (bag.errors && bag.errors.length) {
    parts.push(``);
    parts.push(`Tool notes:`);
    for (const e of bag.errors) parts.push(`- ${e.tool}: ${e.error}`);
  }
  return parts.join("\n");
}

function buildFetchSynthesisPrompt(message, bag) {
  const parts = [];
  const page = bag.page || {};
  const listingSite = !!(page.listingSite || (page.url && isListingSiteUrl(page.url)));
  const listings = Array.isArray(page.listings) ? page.listings : [];
  parts.push(`You are AIPickVault Desktop — a general local research assistant. Review the fetched webpage for Blake.`);
  parts.push(`Hard rules:`);
  parts.push(`- You CAN view/analyze websites when page content is provided below. Never say you cannot view websites.`);
  if (listingSite) {
    parts.push(`- This is a VEHICLE LISTING SEARCH / RESULTS page (Autotrader, Cars.com, CarGurus, etc.).`);
    parts.push(`- Summarize VEHICLES FOR SALE from the extracted listing candidates / text ONLY: year, trim, price, mileage, dealer/location, link when present.`);
    parts.push(`- NEVER pivot into new-car trim/package marketing explainers (e.g. "Make it Mine", LE vs XLE feature essays) unless the page is actually a trim guide — and even then say so.`);
    parts.push(`- If structured listings are present, lead with a short table/list of those cars. If HTML was thin / JS-heavy with few sale cards, say so honestly and suggest a web-search fallback or ask Blake to paste 2–3 listing cards — do NOT invent inventory.`);
    parts.push(`- Do not invent asking prices, miles, or dealer claims absent from the extract.`);
    parts.push(`- ~40k mi/yr (Blake's annual use) is NOT a hard listing odometer cap. Prefer lower miles; higher OK if price/condition/PPI justify.`);
  } else {
    parts.push(`- Give real design/content feedback: clarity, tone, structure, trust signals, CTAs, what works / what to improve.`);
  }
  parts.push(`- Base feedback on the extracted title + text (+ listing candidates). If text is thin or fetch failed, say so clearly.`);
  parts.push(`- On fetch failure (HTTP 403/blocked): short human message + practical next step (web search for listings near 76177, or paste 2–3 cards). NEVER lecture about .env or API keys for a public webpage HTTP 403.`);
  parts.push(`- Do NOT claim you are limited to vehicle recommendations. No "Fort Worth Local Advisor" branding.`);
  parts.push(`- Do not invent quotes or sections that are not in the extracted text.`);
  parts.push(`- No raw JSON. Short structured sections.`);
  if (Array.isArray(bag.lessons) && bag.lessons.length) {
    parts.push(``);
    parts.push(`Durable lessons (obey):`);
    for (const L of bag.lessons.slice(-10)) parts.push(`- ${L}`);
  }
  parts.push(``);
  parts.push(`User question:`);
  parts.push(message);
  parts.push(``);
  parts.push(`Intent: fetch`);
  if (bag.page) {
    parts.push(``);
    if (bag.page.error) {
      parts.push(`Fetch failed: ${bag.page.error}`);
      if (bag.page.url) parts.push(`URL: ${bag.page.url}`);
      if (bag.page.fallbackSearchQuery) {
        parts.push(`Suggested search fallback query: ${bag.page.fallbackSearchQuery}`);
      }
      parts.push(`Tell Blake the site blocked the fetch; offer to search the open web for similar listings near 76177 OR ask him to paste 2–3 listing cards. No .env / API-key advice.`);
    } else {
      parts.push(`Fetched page:`);
      parts.push(`URL: ${bag.page.finalUrl || bag.page.url || "(unknown)"}`);
      if (bag.page.title) parts.push(`Title: ${bag.page.title}`);
      if (bag.page.truncated) parts.push(`(Extract truncated for size.)`);
      if (bag.page.jsHeavy) parts.push(`Note: page looked JS-heavy / thin on listing cards.`);
      if (listings.length) {
        parts.push(`Structured listing candidates (${listings.length}):`);
        parts.push(JSON.stringify(listings.slice(0, 12), null, 2));
      }
      parts.push(`Extracted text:`);
      parts.push(String(bag.page.text || "").slice(0, 10000));
    }
  } else {
    parts.push(``);
    parts.push(`No page content was retrieved.`);
  }
  if (Array.isArray(bag.web) && bag.web.length) {
    parts.push(``);
    parts.push(`Web search fallback results (use if fetch failed or listings were thin):`);
    parts.push(formatWebResults(bag.web));
  }
  if (bag.errors && bag.errors.length) {
    parts.push(``);
    parts.push(`Tool notes:`);
    for (const e of bag.errors) parts.push(`- ${e.tool}: ${e.error}`);
  }
  return parts.join("\n");
}

function buildSynthesisPrompt(message, intent, bag, wantsRecommendation) {
  if (intent === "weather") return buildWeatherSynthesisPrompt(message, bag);
  if (intent === "fetch") return buildFetchSynthesisPrompt(message, bag);

  if (intent === "stock" || intent === "stock_compare" || intent === "news") {
    const parts = [];
    parts.push("You are AIPickVault Desktop — a general local research assistant. Answer clearly for Blake.");
    parts.push("Hard rules:");
    parts.push("- Never brand yourself \"Fort Worth Local Advisor\" (or similar).");
    parts.push("- No gig-vehicle / Corolla / DoorDash asides unless the user asked about that.");
    parts.push("- Use ONLY the tool data below; do not invent prices or headlines.");
    parts.push("- Cite titles + links from the lists when present. No raw JSON. Short structured sections.");
    parts.push("");
    parts.push("User question:");
    parts.push(message);
    parts.push("");
    parts.push("Intent: " + intent);
    if (bag.news && bag.news.length) {
      parts.push("");
      parts.push("News results:");
      parts.push(formatNewsResults(bag.news));
    }
    if (bag.stocks && Object.keys(bag.stocks).length) {
      parts.push("");
      parts.push("Stock / finance data:");
      for (const [sym, data] of Object.entries(bag.stocks)) {
        parts.push(sym + ":");
        parts.push(JSON.stringify(data, null, 2));
      }
    }
    if (bag.web && bag.web.length) {
      parts.push("");
      parts.push("Web search results:");
      parts.push(formatWebResults(bag.web));
    }
    if (bag.errors && bag.errors.length) {
      parts.push("");
      parts.push("Tool notes:");
      for (const e of bag.errors) parts.push("- " + e.tool + ": " + e.error);
    }
    return parts.join("\n");
  }

  const parts = [];
  const gig = extractGigUseCase(message);
  const criteria = extractCriteria(message);
  const budget = extractBudget(message);
  const vehicle = isVehicleAsk(message);

  parts.push(`You are AIPickVault Desktop — a general local research assistant for Blake (Fort Worth / Alliance 76177). Think hard, then answer decisively.`);
  parts.push(`- Never brand yourself "Fort Worth Local Advisor" (or similar). No gig-vehicle asides unless this turn is about that subject.`);
  parts.push(`You are a general local research assistant — NOT vehicle-only. Gig/vehicle specialist framing applies only because this turn is about that subject.`);
  parts.push(`Reasoning (do this mentally; do NOT dump chain-of-thought as the reply):`);
  parts.push(`- Weigh tradeoffs for HIS situation (high miles, city stop-go, cargo, Texas heat/insurance) — not generic brochure talk.`);
  parts.push(`- Challenge weak evidence: app-store pages, wrong-country hits, luxury rideshare flex posts, incomplete snippets.`);
  parts.push(`- Prefer a coherent ranked recommendation over tool-meta or apologies.`);
  parts.push(`Hard rules:`);
  parts.push(`- NEVER open with "No tool results…", "Sources focus on…", "The tool results do not provide…", "All cited sources…", or "best-effort guidance (based on general knowledge, not sources)". Lead with the pick.`);
  parts.push(`- Lead with a direct recommendation ranked by overall annual cost, reliability, and maintenance for high-mileage gig/courier use.`);
  parts.push(`- Cite ONLY titles + exact links that appear in the tool lists below. Never invent URLs, Autotrader/Cars.com listing links, or fake AAA/insurance stats.`);
  parts.push(`- Never invent specific for-sale cars, VINs, dealer inventory, asking prices, or "verified at dealer" claims. If no live listings are in tool results, say to check Autotrader/Cars.com filters for Fort Worth / Alliance (76177).`);
  parts.push(`- Label estimates clearly vs sourced facts. Include a short "Sourced vs estimate" line when mixing both.`);
  const hasLiveWeb = Array.isArray(bag.web) && bag.web.length > 0;
  const hasLiveNews = Array.isArray(bag.news) && bag.news.length > 0;
  const packOnly = !!(bag.domainPack && String(bag.domainPack).length > 40) && !hasLiveWeb && !hasLiveNews;
  if (packOnly) {
    parts.push(`- PACK-ONLY turn: no live web/news tool results were used. In "Sourced vs estimate", say pack heuristic / estimate (local gig-vehicle specialist pack) ONLY. Do NOT invent TDI, DFW market scrapes, dealer quotes, Autotrader/Cars.com "sources", listing prices, fake citations, SOH %, failure probabilities, reliability index scores, or NHTSA campaign details. Point to Autotrader/Cars.com filters for Fort Worth / Alliance (76177) without claiming you pulled live inventory.`);
  }
  if (isPlatformEligibilityAsk(message)) {
    parts.push(`- PLATFORM POLICY MODE (mandatory): Only state year cutoffs / age windows that appear in the tool text below. Policies are city-specific and change.`);
    parts.push(`- Never invent help URLs. Only cite exact links from tool results. Prefer official Texas/Dallas/DFW pages when present.`);
    parts.push(`- Never equate model year with manufacture year incorrectly (e.g. do NOT claim "2010 Corolla = 2011 model year").`);
    parts.push(`- If tools conflict or a page says regions differ, say so explicitly and link the official pages from results.`);
    parts.push(`- If tool text is missing a cutoff, say you could not verify from live sources — do NOT guess from the gig pack.`);
    parts.push(`- When advising rideshare + food apps together: recommend checking both platforms; prefer model years that satisfy the stricter tool-sourced cutoff.`);
  } else if (gig.isGig || /\b(lyft|uber|doordash)\b/i.test(message)) {
    parts.push(`- Do NOT claim Lyft/Uber/DoorDash vehicle eligibility or year cutoffs unless those exact figures appear in tool text. Pack may still recommend Corolla for TCO.`);
  }
  parts.push(`- Do not invent NHTSA recall campaign IDs unless present in tool text; if unsure, say so and rely on what the sources show.`);
  parts.push(`- ANTI-FAKE-STATS: Never invent SOH percentages or hard SOH cutoffs (e.g. SOH < 80% reject), failure probabilities, "X% of cars", reliability index scores (e.g. 3.2/5.0), insurance %, "guaranteed" claims, exact gallon/$ fuel-penalty figures, or precise chance-of-failure numbers unless those exact figures appear in the tool result text below. Prefer qualitative: "battery health varies; require PPI / SOH report; if battery unknown/weak → Corolla; fuel savings can be meaningful but battery risk can erase them at high annual miles."`);
  parts.push(`- Do not over-claim NHTSA sourcing. If campaign details are not in tool snippets, say you do not have the campaign text — do not fabricate IDs or rates.`);
  parts.push(`- Rough annual cost buckets (fuel, insurance, maintenance, tires) OK if labeled estimates with uncertainty. Illustrative ranges OK only if clearly labeled estimate; prefer qualitative. No fake precision. Do NOT double-count buckets (e.g. tires twice).`);
  parts.push(`- Prefer Alliance / Fort Worth 76177 framing; never invent ZIP bands (e.g. 76102–76140).`);
  const listingAsk = isLocateRecommendedVehicleAsk(message);
  const packBackedLocate = isPackBackedLocateAsk(message);
  const gigDomainAsk = (() => {
    try { return isGigVehicleDomainAsk(message, { intent, payload: { wantsRecommendation: !!wantsRecommendation } }); }
    catch (_) { return !!(gig.isGig || packBackedLocate || isYearRecallAsk(message)); }
  })();
  const useGigPackFraming = !!(
    packBackedLocate ||
    isYearRecallAsk(message) ||
    gig.isGig ||
    (gigDomainAsk && !listingAsk)
  );

  if (useGigPackFraming) {
    parts.push(`- LOCKED: Corolla **2010–2015 LE/SE** (not XLE-only, not 2014–2015-only). At ~40k mi/yr Corolla is safe default; Prius Gen3 only with verified healthy battery via PPI/battery report.`);
    parts.push(`- ~40k mi/yr is ANNUAL USE — never invent a hard under-40k listing odometer cap. Prefer lower miles; higher OK if price/condition/PPI justify.`);
    parts.push(`- Never invent example asking prices/URLs, claim "I've tested this", "100% of listings", "100% safe", or "2010–2013 too risky" without tool evidence.`);
    parts.push(`- Year-recall ("what years" / "forgot what years") → answer 2010–2015 LE/SE from the domain pack.`);
    parts.push(`- Locate/find the recommended Corolla/Prius → the pack recommendation EXISTS (Corolla 2010–2015 LE/SE default). Never say "no specific Corolla was previously recommended." Restate pack pick + listing filters / tool links near 76177; never invent listings.`);
  } else if (listingAsk) {
    parts.push(`- Vehicle listing search: use the make/model/years/budget the user named. Do NOT substitute Corolla 2010–2015 or invent gig-pack defaults for a different vehicle.`);
    parts.push(`- Never invent specific for-sale cars, VINs, dealer inventory, asking prices, or listing URLs.`);
  }
  if (listingAsk) {
    parts.push(`- LOCATE/FIND LISTING bans:`);
    parts.push(`- Never conclude "no listings exist" (or equivalent scarcity) from market-average / CarGurus averages / Edmunds guide / valuation pages alone.`);
    parts.push(`- Never invent "mislabeled year" traps, "ignore the $X listing", or "typically" dealer-fraud claims unless that exact claim appears in tool text.`);
    parts.push(`- If search results are only guides/averages (not concrete for-sale cards with year/price/miles/link), say: tools didn't return live listing cards — give an exact Autotrader/Cars.com filter URL the user can open, and ask them to paste 2–3 listing links/cards.`);
    parts.push(`- Prefer quoting only concrete listing titles/prices/URLs that appear in tool results. Honesty over fake scarcity — do not claim to scrape live inventory if tools cannot.`);
    if (budget != null) {
      parts.push(`- Budget ceiling ~$${budget}: keep listing search/advice under $${budget} / max price ${budget}.`);
    }
  }
  parts.push(`- If sources are thin/spammy, still advise like a decisive courier-aware local using solid US used-car knowledge. Do not apologize about tools.`);
  parts.push(`- Ban nonsense: do NOT call mainstream US-market cars (Honda, Toyota, Hyundai, Kia, etc.) "foreign imports to avoid." Judge reliability, parts cost, MPG.`);
  parts.push(`- No raw JSON. Short structured sections.`);

  if (listingAsk && !useGigPackFraming) {
    parts.push(`Structure:`);
    parts.push(`1) Lead with concrete for-sale results from tool text (year/trim/price/miles/link) for the vehicle named — or honest "no live cards" + filter URL + paste request.`);
    parts.push(`2) Keep the make/model/years/budget/location the user named; do not switch to Corolla/gig-pack defaults.`);
    parts.push(`3) Prefer Alliance / Fort Worth 76177 only as default location when user omitted one.`);
  } else if (wantsRecommendation || vehicle || gig.isGig) {
    parts.push(`Structure:`);
    parts.push(`1) Best pick(s) first (model years that often clear the used budget).`);
    parts.push(`2) Why: MPG / stop-go, parts, reliability, cargo.`);
    parts.push(`3) Rough annual cost buckets with uncertainty: fuel, insurance, maintenance, tires.`);
    parts.push(`4) Verify in Fort Worth / Alliance (76177): listings, insurance quote, PPI, platform rules.`);
    if (budget != null) parts.push(`- Budget ceiling ~$${budget}.`);
    if (gig.isGig) parts.push(`- Use-case: ${gig.label || "gig delivery"} — durability at high annual miles.`);
    if (criteria.annualCost || criteria.reliability || criteria.maintenance) {
      parts.push(`- Rank on annual running cost, reliability, maintenance — not badge prestige.`);
    }
    parts.push(`- Best Choice / Runner Up / Third Choice (Avoid only for truly bad gig picks: thirsty trucks, project cars).`);
  }

  if (useGigPackFraming || isYearRecallAsk(message) || (bag.domainPack && (packBackedLocate || gig.isGig || isYearRecallAsk(message)))) {
    parts.push(``);
    parts.push(`Knowledge-first mode: reason from the local domain pack + durable memory first. Use tool results only to verify live facts (recalls, prices, listings, insurance). Do not invent listings.`);
    parts.push(domainPackPromptSection());
  } else if (listingAsk) {
    parts.push(``);
    parts.push(`Listing-search mode: answer about the vehicle the user named. Quote only concrete listing facts from tool text. Do not invent inventory or pivot to Corolla/gig-pack defaults.`);
  }

  if (Array.isArray(bag.lessons) && bag.lessons.length) {
    parts.push(``);
    parts.push(`Durable lessons (obey):`);
    for (const L of bag.lessons.slice(-10)) parts.push(`- ${L}`);
  }
  parts.push(``);
  parts.push(`User question:`);
  parts.push(message);
  parts.push(``);
  parts.push(`Intent: ${intent}`);

  const webForPrompt = Array.isArray(bag.web) ? rankWebResultsForSynth(bag.web) : bag.web;
  if (webForPrompt && webForPrompt.length) {
    parts.push(``);
    parts.push(`Web search results (ranked; prefer Edmunds/KBB/CR/RepairPal/Fuelly/Reddit; ignore app-store spam):`);
    parts.push(formatWebResults(webForPrompt));
  } else if (bag.web) {
    parts.push(``);
    parts.push(`Web search results: (none useful — still give a direct advisor answer)`);
  }

  if (bag.news && bag.news.length) {
    parts.push(``);
    parts.push(`News results:`);
    parts.push(formatNewsResults(bag.news));
  } else if (bag.news) {
    parts.push(``);
    parts.push(`News results: (none)`);
  }

  if (bag.stocks && Object.keys(bag.stocks).length) {
    parts.push(``);
    parts.push(`Stock / finance data:`);
    for (const [sym, data] of Object.entries(bag.stocks)) {
      parts.push(`${sym}:`);
      parts.push(JSON.stringify(data, null, 2));
    }
  }

  if (bag.weather) {
    parts.push(``);
    parts.push(`Weather data:`);
    parts.push(JSON.stringify(bag.weather, null, 2));
  }

  if (bag.page) {
    parts.push(``);
    parts.push(`Fetched page:`);
    parts.push(JSON.stringify({
      url: bag.page.url,
      finalUrl: bag.page.finalUrl,
      title: bag.page.title,
      error: bag.page.error || null,
      textPreview: bag.page.text ? String(bag.page.text).slice(0, 2000) : null
    }, null, 2));
  }

  if (bag.errors && bag.errors.length) {
    parts.push(``);
    parts.push(`Tool notes (do not lead the reply with these; do not invent replacements):`);
    for (const e of bag.errors) parts.push(`- ${e.tool}: ${e.error}`);
  }

  return parts.join("\n");
}


async function runResearchLoop(opts) {
  const message = String(opts.message || "");
  const route = opts.route || { intent: "chat", payload: {} };
  const model = opts.model || "qwen3:30b";
  const stream = opts.stream || { note() {}, chunk() {} };
  const askOllama = opts.askOllama;
  const toolFns = opts.tools;
  let steps = enforcePlatformEligibilityPlan(planTools(route, message), message, route);
  if (
    (isPlatformEligibilityAsk(message) || (route.payload && route.payload.platformEligibility)) &&
    steps.every((s) => s.tool === "domain")
  ) {
    steps = enforcePlatformEligibilityPlan([], message, route);
  }
  const wantsRecommendation = !!(route.payload && route.payload.wantsRecommendation);
  const skipSynthesize = !!opts.skipSynthesize;

  if (!steps.length) {
    return { text: "", model, plan: [], bag: { web: null, news: null, stocks: {}, weather: null, page: null, domainPack: null, errors: [] }, skipped: true };
  }

  const bag = { web: null, news: null, stocks: {}, weather: null, page: null, domainPack: null, errors: [] };

  for (const s of steps) {
    if (s.queryMeta && s.queryMeta.wasRewritten) {
      stream.note(`Query rewrite: "${String(s.queryMeta.original || "").slice(0, 80)}" â†’ "${s.args.query}"`);
    } else if (s.tool === "search" && s.args && s.args.query) {
      stream.note(`Search query: "${s.args.query}"`);
    }
  }

  if (route.intent === "weather") {
    const loc = (route.payload && route.payload.location) || "Fort Worth";
    stream.note(`Checking weather for ${loc}…`);
  } else if (route.intent === "fetch") {
    const u = (route.payload && route.payload.url) || "page";
    stream.note(`Fetching webpage: ${u}…`);
  } else {
    stream.note(`Research plan (${steps.length} step${steps.length === 1 ? "" : "s"}): ${describePlan(steps)}`);
  }

  let i = 0;
  let stepOrdinal = 0;
  let autoFollowUpDone = false;

  while (i < steps.length) {
    const step = steps[i];
    const group = step.parallelGroup;
    let batch = [step];
    if (group) {
      while (i + batch.length < steps.length && steps[i + batch.length].parallelGroup === group) {
        batch.push(steps[i + batch.length]);
      }
    }

    if (batch.length === 1) {
      stepOrdinal += 1;
      const s = batch[0];
      const totalLabel = steps.length;

      if (s.refineFrom === "search" && Array.isArray(bag.web) && bag.web.length) {
        const refined = refineNewsTopic(s.args.topic, bag.web);
        if (refined && refined !== s.args.topic) {
          s.args = { ...s.args, topic: refined };
          stream.note(`Step ${stepOrdinal}/${totalLabel}: ${s.label} (refined topic)…`);
        } else {
          stream.note(`Step ${stepOrdinal}/${totalLabel}: ${s.label}…`);
        }
      } else {
        const detail =
          s.tool === "search" ? ` for "${s.args.query}"`
            : s.tool === "news" ? ` on "${s.args.topic}"`
              : s.tool === "stock" ? ` ${s.args.symbol || ""}`
                : s.tool === "weather" ? ` for ${s.args.location || ""}` : "";
        stream.note(`Step ${stepOrdinal}/${totalLabel}: ${s.label}${detail}…`);
      }

      const outcome = await executeStep(s, toolFns);
      mergeStepResult(bag, s, outcome);

      if (outcome.ok) {
        if (outcome.kind === "domain") stream.note("Domain pack loaded (knowledge-first — tools only if verification needed).");
        else if (outcome.kind === "web") stream.note(`Found ${outcome.data.length} web result${outcome.data.length === 1 ? "" : "s"}.`);
        else if (outcome.kind === "news") stream.note(`Found ${outcome.data.length} headline${outcome.data.length === 1 ? "" : "s"}.`);
        else if (outcome.kind === "stock" && outcome.data && outcome.data.price != null) {
          stream.note(`${outcome.symbol}: $${outcome.data.price}` + (outcome.data.changePercent != null ? ` (${outcome.data.changePercent})` : ""));
        } else if (outcome.kind === "weather" && outcome.data && outcome.data.location) {
          const w = outcome.data;
          const bits = [w.location];
          if (w.current) bits.push(`${w.current.temp_f}Â°F, ${w.current.condition || ""}`.trim());
          stream.note(`Weather loaded: ${bits.join(" — ")}`);
        } else if (outcome.kind === "page" && outcome.data) {
          if (outcome.data.title) stream.note(`Page loaded: ${outcome.data.title}`);
          else if (outcome.data.url) stream.note(`Page loaded: ${outcome.data.url}`);
          else stream.note("Page content loaded.");
        }
      } else {
        stream.note(`${s.label} unavailable${outcome.error ? ": " + String(outcome.error).slice(0, 80) : ""}. Continuing…`);
      }

      // Listing-site fetch 403/blocked/thin → fallback web search from URL params
      if (
        s.tool === "fetch" &&
        !outcome.ok &&
        steps.length < MAX_STEPS &&
        !steps.some((x) => x.tool === "search")
      ) {
        const page = outcome.data || bag.page || {};
        const url = (s.args && s.args.url) || page.url || (route.payload && route.payload.url) || "";
        const shouldFallback =
          page.blocked ||
          page.listingSite ||
          isListingSiteUrl(url) ||
          /HTTP\s*(403|429|503)/i.test(String(outcome.error || "")) ||
          /JavaScript-rendered|blocked|Timed out/i.test(String(outcome.error || ""));
        if (shouldFallback) {
          const q =
            page.fallbackSearchQuery ||
            listingSearchQueryFromUrl(url) ||
            "Toyota Corolla 2010-2015 for sale Fort Worth 76177";
          steps.splice(i + 1, 0, {
            id: "search_fetch_fallback",
            tool: "search",
            label: "Web search (listing fetch fallback)",
            args: { query: q },
            mergeWeb: true
          });
          stream.note(`Listing fetch blocked/thin — falling back to search: "${q}"`);
        }
      }

      // Thin listing HTML with zero candidates → also search fallback
      if (
        s.tool === "fetch" &&
        outcome.ok &&
        outcome.data &&
        outcome.data.listingSite &&
        (!outcome.data.listings || outcome.data.listings.length === 0) &&
        (outcome.data.jsHeavy || outcome.data.fallbackSearchQuery) &&
        steps.length < MAX_STEPS &&
        !steps.some((x) => x.tool === "search")
      ) {
        const q = outcome.data.fallbackSearchQuery || listingSearchQueryFromUrl(outcome.data.url || (s.args && s.args.url));
        if (q) {
          steps.splice(i + 1, 0, {
            id: "search_fetch_fallback",
            tool: "search",
            label: "Web search (thin listing page)",
            args: { query: q },
            mergeWeb: true
          });
          stream.note(`Listing page had few sale cards — adding search: "${q}"`);
        }
      }

      if (
        !autoFollowUpDone && s.tool === "search" && s.id === "search" && outcome.kind === "web" &&
        steps.length < MAX_STEPS && !steps.some((x) => x.id === "search2" || x.id === "search3") &&
        resultsSeemThinOrOffTopic(bag.web, message, s.args.query)
      ) {
        autoFollowUpDone = true;
        const rw = rewriteSearchQuery(message, { wantsRecommendation: wantsRecommendation || true });
        const followQ = rw.alternate || rw.queries[1] || `reliable affordable ${rw.primary || s.args.query}`.slice(0, 100);
        if (followQ && followQ.toLowerCase() !== String(s.args.query).toLowerCase()) {
          steps.splice(i + 1, 0, {
            id: "search2", tool: "search", label: "Web search (auto-refined)",
            args: { query: followQ }, mergeWeb: true
          });
          stream.note(`First results looked thin/off-topic — adding refined search: "${followQ}"`);
        }
      }
    } else {
      stepOrdinal += batch.length;
      stream.note(`Steps ${stepOrdinal - batch.length + 1}–${stepOrdinal}/${steps.length}: ${batch.map((b) => b.label).join(" + ")} (parallel)…`);
      const outcomes = await Promise.all(batch.map((s) => executeStep(s, toolFns)));
      outcomes.forEach((outcome, idx) => {
        mergeStepResult(bag, batch[idx], outcome);
        if (outcome.ok && outcome.kind === "stock" && outcome.data && outcome.data.price != null) {
          stream.note(`${outcome.symbol}: $${outcome.data.price}` + (outcome.data.changePercent != null ? ` (${outcome.data.changePercent})` : ""));
        } else if (!outcome.ok) {
          stream.note(`${batch[idx].label} unavailable. Continuing…`);
        }
      });
    }
    i += batch.length;
  }

  if (Array.isArray(bag.web) && bag.web.length) bag.web = rankWebResultsForSynth(bag.web);

  const citations = countCitations(bag);
  const hasStock = bag.stocks && Object.keys(bag.stocks).some((k) => bag.stocks[k] && !bag.stocks[k].error);
  const hasWeather = bag.weather && !bag.weather.error;
  const hasPage = !!(bag.page && !bag.page.error && bag.page.text);
  const hasDomain = !!(bag.domainPack && String(bag.domainPack).length > 40);
  const hasAny = citations > 0 || hasStock || hasWeather || hasPage || hasDomain;

  if (skipSynthesize) return { text: "", model, plan: steps, bag, gathered: true };

  const askOpts = { think: !!opts.think, userMessage: message, route };

  if (!hasAny) {
    if (wantsRecommendation && typeof askOllama === "function") {
      stream.note("Drafting a practical recommendation…");
      const text = await askOllama(buildSynthesisPrompt(message, route.intent, bag, true), model, stream.chunk, askOpts);
      return { text, model, plan: steps, bag };
    }
    const failBits = bag.errors.map((e) => e.error).filter(Boolean);
    const publicHttpFail = failBits.some((e) => /HTTP\s*(403|429|503)/i.test(String(e)) || /blocked|Timed out fetching/i.test(String(e)));
    const listingFail = failBits.some((e) => /autotrader|cars\.com|cargurus|carvana|listing/i.test(String(e))) ||
      (route.intent === "fetch" && route.payload && route.payload.url && isListingSiteUrl(route.payload.url));
    let text;
    if (publicHttpFail || listingFail) {
      const fbq = (bag.page && bag.page.fallbackSearchQuery) ||
        (route.payload && route.payload.url && listingSearchQueryFromUrl(route.payload.url)) ||
        null;
      const httpBit = (failBits[0] && (String(failBits[0]).match(/HTTP\s*\d+/) || []))[0];
      text = listingFail
        ? ("That listing site blocked the page fetch" +
            (httpBit ? " (" + httpBit + ")" : "") +
            ". I can search the open web for similar Corolla/Prius listings near 76177, or you can paste 2–3 listing cards here." +
            (fbq ? " Suggested search: " + fbq + "." : ""))
        : "I couldn't load that page right now (site blocked or timed out). Try another link, or paste the key text — no API-key setup needed for public pages.";
    } else if (failBits.length > 0) {
      const looksMissingKey = /not configured|\.env|API key/i.test(String(failBits[0]));
      text = looksMissingKey
        ? `I couldn't retrieve reliable live data right now (${failBits[0]}). Check API keys in .env and try again.`
        : `I couldn't retrieve reliable live data right now (${failBits[0]}). Please try again in a moment.`;
    } else {
      text = "I couldn't retrieve reliable live data right now. Please try again in a moment.";
    }
    return { text, model, plan: steps, bag };
  }

  const eligibilityAsk =
    isPlatformEligibilityAsk(message) || !!(route.payload && route.payload.platformEligibility);

  // Hard gate at synth time: eligibility must not pack-only complete
  if (eligibilityAsk && citations === 0 && !hasPage) {
    stream.note("SELF_VERIFY RETRY: platform eligibility blocked pack-only — fetching official policy…");
    if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("RETRY", "pack_only_blocked");
    if (typeof opts.onLesson === "function") {
      opts.onLesson(
        "Lyft/Uber/DoorDash vehicle age requires live official fetch; never invent year cutoffs from the gig pack.",
        "pack-only-blocked"
      );
    }
    const eq = platformEligibilitySearchQueries(message);
    for (const q of eq.slice(0, Math.max(1, MAX_STEPS - steps.length))) {
      const step = {
        id: "search_elig_gate",
        tool: "search",
        label: "Web search (platform policy gate)",
        args: { query: q },
        mergeWeb: true
      };
      steps.push(step);
      stream.note(`Mandatory policy search: "${q}"`);
      const outcome = await executeStep(step, toolFns);
      mergeStepResult(bag, step, outcome);
    }
    if (Array.isArray(bag.web) && bag.web.length) bag.web = rankWebResultsForSynth(bag.web);
  }

  const citations2 = countCitations(bag);
  const hasPage2 = !!(bag.page && !bag.page.error && bag.page.text);
  const packOnlySynth = hasDomain && citations2 === 0 && !hasStock && !hasWeather && !hasPage2;

  if (eligibilityAsk && packOnlySynth) {
    stream.note("SELF_VERIFY FAIL: could not retrieve platform policy sources");
    if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("FAIL", "no_policy_sources");
    if (typeof opts.onLesson === "function") {
      opts.onLesson(
        "Platform eligibility ask failed without live sources — refuse invented year cutoffs; tell user to check official help pages.",
        "self-verify-fail"
      );
    }
    const failText =
      "I couldn't verify platform vehicle age/eligibility from live official sources just now. " +
      "I won't invent year cutoffs from the local pack. Please retry, or open the official help pages " +
      "(e.g. Lyft Texas driver info / Uber local vehicle requirements) and paste the age line if you want me to interpret it.";
    return { text: failText, model, plan: steps, bag, selfVerify: "FAIL" };
  }

  if (Array.isArray(opts.lessons) && opts.lessons.length) {
    bag.lessons = opts.lessons;
  }

  if (packOnlySynth) {
    stream.note("Using gig-vehicle specialist knowledge…");
  } else if (route.intent === "weather" || (hasWeather && citations2 === 0 && !hasStock && !hasPage2 && !hasDomain)) {
    stream.note("Summarizing weather…");
  } else if (route.intent === "fetch" || hasPage2) {
    stream.note("Reviewing page content…");
  } else {
    stream.note(`Synthesizing from ${citations2 || "tool"} source${citations2 === 1 ? "" : "s"}…`);
  }

  let prompt = buildSynthesisPrompt(message, route.intent, bag, wantsRecommendation);
  let text = await askOllama(prompt, model, stream.chunk, askOpts);

  // Post-draft self-critique (one retry max)
  let verify = evaluateSelfVerify(text, bag);
  if (verify.needed && !opts.skipSelfVerify) {
    stream.note("SELF_VERIFY RETRY: " + verify.reason);
    if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("RETRY", verify.reason);
    const eq = platformEligibilitySearchQueries(message);
    const retryQ = eq[0] || ("vehicle requirements model year " + message).slice(0, 100);
    const retryStep = {
      id: "search_self_verify",
      tool: "search",
      label: "Web search (self-verify)",
      args: { query: retryQ },
      mergeWeb: true
    };
    steps.push(retryStep);
    stream.note(`Self-verify search: "${retryQ}"`);
    const outcome = await executeStep(retryStep, toolFns);
    mergeStepResult(bag, retryStep, outcome);
    if (Array.isArray(bag.web) && bag.web.length) bag.web = rankWebResultsForSynth(bag.web);

    // Prefer fetch of an official help URL from results when present
    const official = (bag.web || []).find((r) => {
      const u = String((r && (r.link || r.url)) || "").toLowerCase();
      return OFFICIAL_POLICY_HOSTS.some((h) => u.includes(h));
    });
    if (official && toolFns && typeof toolFns.fetchWebpage === "function" && steps.length < MAX_STEPS + 2) {
      const url = official.link || official.url;
      const fetchStep = {
        id: "fetch_self_verify",
        tool: "fetch",
        label: "Fetch official policy page",
        args: { url }
      };
      steps.push(fetchStep);
      stream.note(`Self-verify fetch: ${url}`);
      const fout = await executeStep(fetchStep, toolFns);
      mergeStepResult(bag, fetchStep, fout);
    }

    prompt = buildSynthesisPrompt(message, route.intent, bag, wantsRecommendation);
    // Re-synthesize once (fresh stream chunks append)
    stream.note("Re-synthesizing after self-verify…");
    text = await askOllama(prompt, model, stream.chunk, askOpts);
    verify = evaluateSelfVerify(text, bag);
    if (verify.ok) {
      stream.note("SELF_VERIFY PASS");
      if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("PASS", verify.reason);
    } else {
      stream.note("SELF_VERIFY FAIL: " + verify.reason);
      if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("FAIL", verify.reason);
      if (typeof opts.onLesson === "function") {
        opts.onLesson(
          "Lyft/Uber vehicle age requires live official fetch; never invent year cutoffs. Self-verify failed: " + verify.reason,
          "self-verify-fail"
        );
      }
      // Soften: append honesty note rather than shipping unsupported cutoffs silently
      if (!/could not verify|couldn't verify|unable to verify/i.test(text)) {
        text =
          text +
          "\n\nNote: I could not fully verify platform year cutoffs against live official tool text — treat any specific year rules above as unverified and check the official help page for your city.";
      }
    }
  } else if (verify.status === "PASS" && (platformPolicyClaimSafe(text) || eligibilityAsk)) {
    stream.note("SELF_VERIFY PASS");
    if (typeof opts.onSelfVerify === "function") opts.onSelfVerify("PASS", verify.reason);
  }

  return { text, model, plan: steps, bag, selfVerify: verify.status };
}

function platformPolicyClaimSafe(draft) {
  return /\b(lyft|uber|doordash)[\s\S]{0,80}\b(require|or newer|vehicle age|model year)\b/i.test(String(draft || ""));
}

module.exports = {
  planTools, runResearchLoop, formatWebResults, formatNewsResults, refineNewsTopic,
  describePlan, rewriteSearchQuery, rewriteNewsTopic, resultsSeemThinOrOffTopic,
  buildSynthesisPrompt, buildWeatherSynthesisPrompt, buildFetchSynthesisPrompt, extractBudget, extractGigUseCase, extractCriteria,
  hasCostReliabilityLanguage, rankWebResultsForSynth, scoreWebResultForSynth, MAX_STEPS,
  shouldUseKnowledgeFirst, isLocateRecommendedVehicleAsk, isPackBackedLocateAsk, isYearRecallAsk,
  extractVehicleListingSpec, buildVehicleListingQueries,
  isPlatformEligibilityAsk, platformEligibilitySearchQueries,
  evaluateSelfVerify, enforcePlatformEligibilityPlan, collectToolTextBlob
};
