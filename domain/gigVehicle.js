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
  "Never invent listings/prices/URLs; pack-only answers are pack heuristic/estimate; no double-counted cost buckets."
].join("\n");

function isGigVehicleDomainAsk(message, route) {
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
  const vehicleish = /\b(car|truck|suv|vehicle|hybrid|sedan|prius|civic|corolla|camry|accord|cargo\s+van|van|mpg|ownership)\b/i.test(
    text
  );
  const tcoish = /\b(annual\s+cost|cost\s+of\s+ownership|reliability|maintenance|under\s*\$?\d|budget)\b/i.test(
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
  return false;
}

/**
 * True when we should reason from the domain pack and skip (or minimize) web tools.
 * Verification asks (recall/price/listing/insurance) return false — tools still run.
 */
function shouldUseKnowledgeFirst(message, route) {
  if (!isGigVehicleDomainAsk(message, route)) return false;
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

function domainPackPromptSection() {
  return (
    "\n\nLocal domain knowledge pack (prefer this for general advice; tools only to verify live facts):\n" +
    loadGigVehicleDomainPack()
  );
}

module.exports = {
  loadGigVehicleDomainPack,
  isGigVehicleDomainAsk,
  shouldUseKnowledgeFirst,
  domainPackPromptSection,
  MD_PATH
};
