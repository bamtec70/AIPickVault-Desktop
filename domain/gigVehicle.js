"use strict";

/**
 * Local domain knowledge for gig/delivery vehicle advice.
 * Knowledge-first for general TCO/reliability guidance; tools verify recalls/prices/listings.
 */

const fs = require("fs");
const path = require("path");

const MD_PATH = path.join(__dirname, "gig-vehicle.md");

let cached = null;
let cachedMtime = null;

function loadGigVehicleDomainPack() {
  try {
    const st = fs.statSync(MD_PATH);
    const m = st.mtimeMs;
    if (cached && cachedMtime === m) return cached;
    cached = fs.readFileSync(MD_PATH, "utf8").trim();
    cachedMtime = m;
    return cached;
  } catch (_) {
    if (cached) return cached;
    cached = FALLBACK_PACK;
    return cached;
  }
}

const FALLBACK_PACK = [
  "Gig/delivery vehicle heuristics for Blake (Fort Worth / Alliance 76177 — never invent ZIP bands like 76102-76140).",
  "Platforms: DoorDash, Uber, Uber Eats, Roadie, Amazon Flex, Shipt.",
  "Maintains a cargo van; also evaluating sub-$10k car for food/gig delivery.",
  "LOCKED: Corolla 2010-2015 LE/SE is the endorsed safe default (not XLE-only, not 2014-2015-only). Do not invent '2010-2013 too risky' without tool evidence.",
  "Rank by annual cost, reliability, maintenance for ~25-30k mi/yr multi-app gig use; at ~40k mi/yr Corolla 2010-2015 LE/SE is safe default.",
  "~40k mi/yr is ANNUAL USE — not a hard under-40k listing odometer cap. Prefer lower miles; higher OK if price/condition/PPI justify (qualitative).",
  "Endorsed (Blake 2026-09-14, expanded): At ~40k mi/yr Corolla is safe default; Prius Gen3 2010-2015 only if hybrid battery SOH verified healthy via PPI/battery report; unverified Prius → prefer Corolla.",
  "Cargo van for Roadie/Amazon Flex (bulk); sub-$10k car still worth it for food apps — van on food days is a fuel penalty (qualitative: often hundreds of gallons / meaningful $/year; no fake exact gallon counts or $2,000+ as fact).",
  "Corolla can win TCO if Prius battery unverified/bad. Civic 2011-2013 oil dilution = estimate/verify.",
  "Soften precision: no hard SOH < 80% reject; no 10-15% insurance; no guaranteed; no exact gallon arithmetic unless from tools. Require PPI/SOH report; if battery unknown/weak → Corolla; fuel savings can be meaningful but battery risk can erase them at high annual miles.",
  "Never invent listings/prices/URLs/example asks (e.g. $8,995); never claim I've tested this / 100% of listings / 100% safe; pack-only answers are pack heuristic/estimate; no double-counted cost buckets.",
  "Year-recall → answer 2010-2015 Corolla LE/SE from pack. Locate recommended Corolla/Prius → restated pack pick + listing filters near 76177; never pretend no recommendation exists.",
  "ANTI-FAKE-STATS: never invent SOH %, hard SOH cutoffs, failure probabilities, 'X% of cars', reliability index scores, insurance %, exact fuel-penalty figures, or NHTSA campaign details unless present in tool text. Prefer qualitative: battery health varies; require PPI / SOH report. Illustrative ranges OK only if clearly labeled estimate."
].join("\n");

/** Named models + common typos (Corrola / Carolla). */
const NAMED_GIG_MODELS =
  /\b(prius(?:es)?|corollas?|corrolas?|carollas?|corrollas?|civics?|camrys?|accords?|yaris(?:es)?|fits?|siennas?|odysseys?|transits?|promasters?|sprinters?|rav4s?|cr[- ]?vs?)\b/i;

function historyBlob(conversationHistory) {
  if (!Array.isArray(conversationHistory) || !conversationHistory.length) return "";
  return conversationHistory
    .slice(-10)
    .map((m) => (m && typeof m === "object" ? m.content : m) || "")
    .join("\n")
    .toLowerCase();
}

function conversationSuggestsGigVehicle(conversationHistory) {
  const blob = historyBlob(conversationHistory);
  if (!blob) return false;
  return (
    NAMED_GIG_MODELS.test(blob) ||
    /\b(doordash|uber\s+eats|roadie|amazon\s+flex|shipt|gig\s+(?:delivery|work)|last\s*mile|cargo\s+van|best\s+car|under\s*\$?\s*10|annual\s+cost|hybrid\s+battery)\b/i.test(
      blob
    )
  );
}

function durableSuggestsGigVehicle(durableMemory) {
  if (!durableMemory) return false;
  let snap = durableMemory;
  try {
    if (typeof durableMemory.getSnapshot === "function") snap = durableMemory.getSnapshot();
  } catch (_) {
    return false;
  }
  const work = (snap && snap.work) || {};
  if (Array.isArray(work.vehicleNotes) && work.vehicleNotes.length > 0) return true;
  if (Array.isArray(work.platforms) && work.platforms.length > 0) return true;
  return false;
}

function isShortVehicleFollowUp(lower) {
  const words = String(lower || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 18) return false;
  return (
    NAMED_GIG_MODELS.test(lower) ||
    /\b(van|car|hybrid|battery|soh|ppi|miles?|mileage|tco|insurance|maintenance|reliability|years?|trims?)\b/i.test(lower)
  );
}

/** "what years / forgot what years" of Corolla/Prius for gig work. */
function isYearRecallAsk(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower.trim()) return false;
  const yearAsk =
    /\b(what|which|forgot|remind|recall)\b[\s\S]{0,40}\byears?\b/i.test(lower) ||
    /\byears?\s+(?:of|for|am|i'?m)\b/i.test(lower) ||
    /\bwhat\s+years?\b/i.test(lower) ||
    /\bforgot\s+what\s+years?\b/i.test(lower);
  if (!yearAsk) return false;
  return (
    NAMED_GIG_MODELS.test(lower) ||
    /\b(gig|doordash|uber|delivery|searching\s+for|looking\s+for)\b/i.test(lower)
  );
}

/**
 * "Locate / find the Corolla/Prius you recommended" — pack answer + listing tools.
 */
function isLocateRecommendedVehicleAsk(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower.trim()) return false;
  const locate =
    /\b(locate|find|search\s+for|look\s*(?:up|for)|show\s+me|help\s+me\s+find)\b/i.test(lower) ||
    /\b(where\s+(?:can|do)\s+i\s+(?:find|buy|get))\b/i.test(lower);
  const recommended =
    /\b(recommend(?:ed|ation)?|you\s+(?:suggested|said|mentioned|picked)|from\s+earlier|the\s+one\s+you)\b/i.test(
      lower
    );
  const model = NAMED_GIG_MODELS.test(lower) || /\b(toyota|honda)\b/i.test(lower);
  return (locate && (recommended || model)) || (recommended && model);
}

/**
 * Hard same-subject vehicle / TCO / mileage / van-vs-car advice — even without
 * repeating "DoorDash". Follow-ups like "Prius vs Corolla at 40k mi/yr" qualify.
 */
function isGigVehicleAdviceText(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (!lower.trim()) return false;

  if (isYearRecallAsk(text) || isLocateRecommendedVehicleAsk(text)) return true;

  const vehicleish = /\b(car|truck|suv|vehicle|hybrid|sedan|prius|civic|corolla|corrola|carolla|camry|accord|cargo\s+van|van|mpg|ownership)\b/i.test(
    text
  );
  const named = NAMED_GIG_MODELS.test(lower);
  const compare =
    /\bvs\.?\b|\bversus\b/.test(lower) ||
    (named && /\bor\b/.test(lower) && /\b(van|car|truck|prius|corolla|corrola|carolla|civic|camry)\b/i.test(lower));
  const mileageTco =
    /\b(\d{1,3}\s*k|\d{4,6})\s*miles?\s*(?:\/|\s)*(?:year|yr|annually)?\b|\bmiles?\s*(?:per|\/)\s*year\b|\bhigh[\s-]?miles?\b|\bannual\s+(?:cost|miles|mileage)\b|\btco\b|\bcost\s+of\s+ownership\b|\bmileage\b/i.test(
      lower
    );
  const vanVsCar =
    /\b(cargo\s+van|van\s+vs|vs\.?\s+.*\bvan\b|car\s+vs\.?\s+van|van\s+for|keep\s+the\s+van|van\s+still\s+win)\b/i.test(
      lower
    );
  const tcoish = /\b(annual\s+cost|cost\s+of\s+ownership|reliability|maintenance|under\s*\$?\d|budget|tco)\b/i.test(
    lower
  );
  const gigPlatform = /\b(doordash|uber|roadie|amazon\s+flex|shipt|gig\s+(?:delivery|work)|last\s*mile|food\s+delivery)\b/i.test(
    lower
  );
  const batteryAdvice = /\b(hybrid\s+battery|battery\s+(?:soh|health|pack)|soh\b|ppi)\b/i.test(lower);

  if (named && (compare || mileageTco || vanVsCar || batteryAdvice || tcoish || gigPlatform)) return true;
  if (vanVsCar && (vehicleish || named || mileageTco || gigPlatform)) return true;
  if (vehicleish && (gigPlatform || tcoish || mileageTco)) return true;
  if (gigPlatform && tcoish) return true;
  return false;
}

function isGigVehicleDomainAsk(message, route, opts) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const payload = (route && route.payload) || {};
  if (payload.forceToolRefresh && !isYearRecallAsk(text) && !isLocateRecommendedVehicleAsk(text)) return false;
  try {
    const { needsFactualRefresh } = require("../router");
    // Year-recall and pack restatements stay on domain path even if "listing" words appear later.
    if (needsFactualRefresh(text) && !isYearRecallAsk(text) && !isLocateRecommendedVehicleAsk(text)) {
      return false;
    }
  } catch (_) {
    /* router may not load in isolation */
  }
  // Platform news / "what's happening today" is live events — not vehicle expertise.
  const liveEvents =
    /\b(what(?:'s| is) happening|latest on|breaking|headlines?|current events)\b/i.test(lower) ||
    (/\b(today|tonight)\b/i.test(lower) && /\b(news|happening|stock|earnings|shares?)\b/i.test(lower));
  if (liveEvents && !/\b(car|truck|suv|vehicle|hybrid|prius|civic|corolla|corrola|carolla|camry|van|budget|under\s*\$)\b/i.test(lower)) {
    return false;
  }

  if (isYearRecallAsk(text)) return true;
  if (isGigVehicleAdviceText(text)) return true;

  const vehicleish = /\b(car|truck|suv|vehicle|hybrid|sedan|prius|civic|corolla|corrola|carolla|camry|accord|cargo\s+van|van|mpg|ownership)\b/i.test(
    text
  );
  const tcoish = /\b(annual\s+cost|cost\s+of\s+ownership|reliability|maintenance|under\s*\$?\d|budget|tco|miles?\s*(?:per|\/)\s*year|\d+\s*k\s*miles?)\b/i.test(
    lower
  );
  const gigPlatform = /\b(doordash|uber|roadie|amazon\s+flex|shipt|gig\s+(?:delivery|work)|last\s*mile|food\s+delivery)\b/i.test(
    lower
  );

  // Specialist pack applies when vehicle/TCO advice intersects gig work — not bare platform chatter.
  if (vehicleish && (gigPlatform || tcoish || payload.wantsRecommendation)) return true;
  if (payload.wantsRecommendation && (vehicleish || tcoish)) return true;
  if (gigPlatform && tcoish) return true;
  if (vehicleish && tcoish) return true;

  // Conversation / durable-memory context: prior gig-car turns keep hard follow-ups on the pack path.
  const ctx = opts || {};
  const hist = conversationSuggestsGigVehicle(ctx.conversationHistory);
  const mem = durableSuggestsGigVehicle(ctx.durableMemory);
  if ((hist || mem) && (vehicleish || isShortVehicleFollowUp(lower) || NAMED_GIG_MODELS.test(lower) || isYearRecallAsk(text))) {
    return true;
  }

  return false;
}

/**
 * True when we should reason from the domain pack and skip (or minimize) web tools.
 * Verification asks (recall/price/listing/insurance) return false — tools still run.
 * Year-recall stays knowledge-first. Locate-recommended needs listing search tools.
 */
function shouldUseKnowledgeFirst(message, route, opts) {
  if (!isGigVehicleDomainAsk(message, route, opts)) return false;
  const text = String(message || "").trim();
  if (isLocateRecommendedVehicleAsk(text)) return false;
  if (/^(search|look\s*up|lookup|find|google)\b/i.test(text) && !isYearRecallAsk(text)) return false;
  const payload = (route && route.payload) || {};
  if (payload.forceToolRefresh && !isYearRecallAsk(text)) return false;
  try {
    const { needsFactualRefresh } = require("../router");
    if (needsFactualRefresh(text) && !isYearRecallAsk(text)) return false;
  } catch (_) {}
  // Explicit live-news tooling wins over pack
  if (Array.isArray(payload.tools) && payload.tools.includes("news") && /\b(happening|today|latest|breaking)\b/i.test(text)) {
    return false;
  }
  return true;
}

/**
 * Upgrade chat (or tool-less) routes to search so planTools can emit plan: domain
 * for gig-vehicle / Prius / Corolla / TCO / mileage / van-vs-car advice — including
 * hard same-subject follow-ups. needsFactualRefresh / forceToolRefresh still win → search tools.
 */
function ensureGigVehicleDomainRoute(message, route, opts) {
  const text = String(message || "").trim();
  const r = route || { intent: "chat", payload: {} };
  const payload = r.payload || {};

  // Never hijack weather/news/stocks/webpage-fetch into the gig-vehicle pack.
  if (["weather", "news", "stock", "stock_compare", "fetch"].includes(r.intent)) {
    return r;
  }

  if (payload.forceToolRefresh && !isYearRecallAsk(text) && !isLocateRecommendedVehicleAsk(text)) {
    return r;
  }
  try {
    const { needsFactualRefresh } = require("../router");
    if (needsFactualRefresh(text) && !isYearRecallAsk(text) && !isLocateRecommendedVehicleAsk(text)) {
      return r;
    }
  } catch (_) {}

  if (!shouldUseKnowledgeFirst(text, r, opts) && !isGigVehicleDomainAsk(text, r, opts) && !isLocateRecommendedVehicleAsk(text)) {
    return r;
  }

  const locate = isLocateRecommendedVehicleAsk(text);
  const yearRecall = isYearRecallAsk(text);

  // Already on a tool path — keep intent; ensure recommendation / locate flags.
  if (r.intent === "search") {
    return {
      ...r,
      payload: {
        ...payload,
        query: payload.query || text,
        tools: Array.isArray(payload.tools) && payload.tools.length ? payload.tools : ["search"],
        wantsRecommendation: true,
        domainPackPreferred: !locate,
        locateRecommendedVehicle: locate || undefined,
        yearRecall: yearRecall || undefined,
        // Locate needs live listing search; year-recall stays pack-first.
        forceToolRefresh: locate ? true : payload.forceToolRefresh
      }
    };
  }

  if (r.intent === "chat" || !r.intent) {
    return {
      intent: "search",
      payload: {
        query: text,
        tools: ["search"],
        wantsRecommendation: true,
        domainPackPreferred: !locate,
        locateRecommendedVehicle: locate || undefined,
        yearRecall: yearRecall || undefined,
        forceToolRefresh: locate ? true : undefined
      }
    };
  }

  return r;
}

function domainPackPromptSection() {
  return (
    "\n\nLocal domain knowledge pack (prefer this for general advice; tools only to verify live facts):\n" +
    loadGigVehicleDomainPack() +
    "\n\nAnti-fake-stats (mandatory): Never invent SOH percentages or hard SOH cutoffs (e.g. SOH < 80% reject), failure probabilities, \"X% of cars\", reliability index scores, insurance %, exact gallon/$ fuel-penalty figures, or NHTSA campaign details unless those exact figures appear in tool result text. Prefer qualitative heuristics (require PPI / SOH report; if battery unknown/weak → Corolla; fuel savings can be meaningful but battery risk can erase them at high annual miles). Illustrative ranges OK only if clearly labeled estimate; prefer qualitative. On pack-only turns, Sourced vs estimate = pack heuristic only. Prefer Alliance / Fort Worth 76177 — never invent ZIP bands." +
    "\nLOCKED years/trim: Corolla **2010–2015 LE/SE** (not XLE-only, not 2014–2015-only). Do not invent \"2010–2013 too risky\" without tool evidence." +
    "\n~40k mi/yr is annual use — NOT a hard under-40k listing odometer filter. Prefer lower miles; higher OK if price/condition/PPI justify." +
    "\nNever invent example asking prices/URLs, claim \"I've tested this\", \"100% of listings\", or \"100% safe\"." +
    "\nYear-recall → answer 2010–2015 LE/SE from pack. Locate recommended vehicle → restate pack pick + offer listing filters near 76177; never pretend no recommendation exists."
  );
}

module.exports = {
  loadGigVehicleDomainPack,
  isGigVehicleDomainAsk,
  isGigVehicleAdviceText,
  isYearRecallAsk,
  isLocateRecommendedVehicleAsk,
  shouldUseKnowledgeFirst,
  ensureGigVehicleDomainRoute,
  conversationSuggestsGigVehicle,
  durableSuggestsGigVehicle,
  domainPackPromptSection,
  NAMED_GIG_MODELS,
  MD_PATH
};

