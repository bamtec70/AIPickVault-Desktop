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
  "Gig/delivery vehicle heuristics for Blake (Fort Worth / Alliance 76177).",
  "Platforms: DoorDash, Uber, Uber Eats, Roadie, Amazon Flex, Shipt.",
  "Maintains a cargo van; also evaluating sub-$10k car for food/gig delivery.",
  "Rank by annual cost, reliability, maintenance for ~25-30k mi/yr multi-app gig use.",
  "Endorsed (2026-09-14): Prius Gen3 2010-2015 only if hybrid battery SOH verified via PPI; else Corolla 2010-2015 LE/SE safest default.",
  "Corolla can win TCO if Prius battery unverified/bad. Civic 2011-2013 oil dilution = estimate/verify.",
  "Van for Roadie/Flex; car for food apps (van fuel penalty on food days).",
  "Never invent listings/prices/URLs; pack-only answers are pack heuristic/estimate; no double-counted cost buckets.",
  "ANTI-FAKE-STATS: never invent SOH %, failure probabilities, 'X% of cars', reliability index scores, or NHTSA campaign details unless present in tool text. Prefer qualitative: battery health varies; require PPI / SOH report."
].join("\n");

const NAMED_GIG_MODELS =
  /\b(prius|corolla|civic|camry|accord|yaris|fit|sienna|odyssey|transit|promaster|sprinter|rav4|cr[- ]?v)\b/i;

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
    /\b(doordash|uber\s+eats|roadie|amazon\s+flex|shipt|gig\s+delivery|last\s*mile|cargo\s+van|best\s+car|under\s*\$?\s*10|annual\s+cost|hybrid\s+battery)\b/i.test(
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
    /\b(van|car|hybrid|battery|soh|ppi|miles?|mileage|tco|insurance|maintenance|reliability)\b/i.test(lower)
  );
}

/**
 * Hard same-subject vehicle / TCO / mileage / van-vs-car advice — even without
 * repeating "DoorDash". Follow-ups like "Prius vs Corolla at 40k mi/yr" qualify.
 */
function isGigVehicleAdviceText(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (!lower.trim()) return false;

  const vehicleish = /\b(car|truck|suv|vehicle|hybrid|sedan|prius|civic|corolla|camry|accord|cargo\s+van|van|mpg|ownership)\b/i.test(
    text
  );
  const named = NAMED_GIG_MODELS.test(lower);
  const compare =
    /\bvs\.?\b|\bversus\b/.test(lower) ||
    (named && /\bor\b/.test(lower) && /\b(van|car|truck|prius|corolla|civic|camry)\b/i.test(lower));
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
  const gigPlatform = /\b(doordash|uber|roadie|amazon\s+flex|shipt|gig\s+delivery|last\s*mile|food\s+delivery)\b/i.test(
    lower
  );
  const batteryAdvice = /\b(hybrid\s+battery|battery\s+(?:soh|health|pack)|soh\b|ppi)\b/i.test(lower);

  if (named && (compare || mileageTco || vanVsCar || batteryAdvice || tcoish)) return true;
  if (vanVsCar && (vehicleish || named || mileageTco || gigPlatform)) return true;
  if (vehicleish && (gigPlatform || tcoish || mileageTco)) return true;
  if (gigPlatform && tcoish) return true;
  return false;
}

function isGigVehicleDomainAsk(message, route, opts) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const payload = (route && route.payload) || {};
  if (payload.forceToolRefresh) return false;
  try {
    const { needsFactualRefresh } = require("../router");
    if (needsFactualRefresh(text)) return false;
  } catch (_) {
    /* router may not load in isolation */
  }
  // Platform news / "what's happening today" is live events — not vehicle expertise.
  const liveEvents =
    /\b(what(?:'s| is) happening|latest on|breaking|headlines?|current events)\b/i.test(lower) ||
    (/\b(today|tonight)\b/i.test(lower) && /\b(news|happening|stock|earnings|shares?)\b/i.test(lower));
  if (liveEvents && !/\b(car|truck|suv|vehicle|hybrid|prius|civic|corolla|camry|van|budget|under\s*\$)\b/i.test(lower)) {
    return false;
  }

  if (isGigVehicleAdviceText(text)) return true;

  const vehicleish = /\b(car|truck|suv|vehicle|hybrid|sedan|prius|civic|corolla|camry|accord|cargo\s+van|van|mpg|ownership)\b/i.test(
    text
  );
  const tcoish = /\b(annual\s+cost|cost\s+of\s+ownership|reliability|maintenance|under\s*\$?\d|budget|tco|miles?\s*(?:per|\/)\s*year|\d+\s*k\s*miles?)\b/i.test(
    lower
  );
  const gigPlatform = /\b(doordash|uber|roadie|amazon\s+flex|shipt|gig\s+delivery|last\s*mile|food\s+delivery)\b/i.test(
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
  if ((hist || mem) && (vehicleish || isShortVehicleFollowUp(lower) || NAMED_GIG_MODELS.test(lower))) {
    return true;
  }

  return false;
}

/**
 * True when we should reason from the domain pack and skip (or minimize) web tools.
 * Verification asks (recall/price/listing/insurance) return false — tools still run.
 */
function shouldUseKnowledgeFirst(message, route, opts) {
  if (!isGigVehicleDomainAsk(message, route, opts)) return false;
  const text = String(message || "").trim();
  if (/^(search|look\s*up|lookup|find|google)\b/i.test(text)) return false;
  const payload = (route && route.payload) || {};
  if (payload.forceToolRefresh) return false;
  try {
    const { needsFactualRefresh } = require("../router");
    if (needsFactualRefresh(text)) return false;
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

  if (payload.forceToolRefresh) return r;
  try {
    const { needsFactualRefresh } = require("../router");
    if (needsFactualRefresh(text)) return r;
  } catch (_) {}

  if (!shouldUseKnowledgeFirst(text, r, opts) && !isGigVehicleDomainAsk(text, r, opts)) {
    return r;
  }

  // Already on a tool path — keep intent; ensure recommendation flag so planners treat it as advice.
  if (r.intent === "search") {
    return {
      ...r,
      payload: {
        ...payload,
        query: payload.query || text,
        tools: Array.isArray(payload.tools) && payload.tools.length ? payload.tools : ["search"],
        wantsRecommendation: true,
        domainPackPreferred: true
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
        domainPackPreferred: true
      }
    };
  }

  return r;
}

function domainPackPromptSection() {
  return (
    "\n\nLocal domain knowledge pack (prefer this for general advice; tools only to verify live facts):\n" +
    loadGigVehicleDomainPack() +
    "\n\nAnti-fake-stats (mandatory): Never invent SOH percentages, failure probabilities, \"X% of cars\", reliability index scores, or NHTSA campaign details unless those exact figures appear in tool result text. Prefer qualitative heuristics (e.g. battery health varies; require PPI / SOH report). On pack-only turns, Sourced vs estimate = pack heuristic only."
  );
}

module.exports = {
  loadGigVehicleDomainPack,
  isGigVehicleDomainAsk,
  isGigVehicleAdviceText,
  shouldUseKnowledgeFirst,
  ensureGigVehicleDomainRoute,
  conversationSuggestsGigVehicle,
  durableSuggestsGigVehicle,
  domainPackPromptSection,
  MD_PATH
};
