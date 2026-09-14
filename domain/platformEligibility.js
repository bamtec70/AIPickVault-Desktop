"use strict";

/**
 * Platform vehicle requirements / age / eligibility — must force live tools.
 * Never answer year cutoffs from the gig pack alone.
 */

const PLATFORM_RE =
  /\b(lyft|uber\s*eats|uber|doordash|door\s*dash|grubhub|instacart|roadie|amazon\s+flex|shipt)\b/i;

const ELIGIBILITY_TOPIC_RE =
  /\b(rules?|requirements?|eligib(?:le|ility)|vehicle\s+age|how\s+old(?:\s+can|\s+is)?|model\s+years?|years?\s+(?:old|or\s+newer|or\s+older)|manufactured\s+(?:after|before|in)|minimum\s+year|max(?:imum)?\s+age|age\s+(?:limit|requirement|cap)|vehicle\s+(?:policy|policies|standards?)|driver\s+(?:requirements?|eligibility|info(?:rmation)?)|car\s+(?:requirements?|eligibility|age)|allowed\s+(?:vehicles?|cars?|years?)|accept(?:s|ed)?\s+(?:vehicles?|cars?|years?)|can\s+(?:my|the)\s+(?:car|vehicle)|what\s+years?\s+(?:does|do|can))\b/i;

function isPlatformEligibilityAsk(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (!lower.trim()) return false;

  const hasPlatform =
    PLATFORM_RE.test(lower) ||
    /\b(rideshare|ride[\s-]?share)\b/i.test(lower);

  if (!hasPlatform) return false;

  if (ELIGIBILITY_TOPIC_RE.test(lower)) return true;

  // "Lyft vehicle years" / "Uber age for cars in DFW"
  if (
    PLATFORM_RE.test(lower) &&
    /\b(years?|age|older|newer|manufactured)\b/i.test(lower) &&
    /\b(vehicle|car|truck|suv|allow|accept|require|need|must|policy|policies|driver)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}

function detectPlatformsInMessage(message) {
  const lower = String(message || "").toLowerCase();
  const out = [];
  if (/\blyft\b/.test(lower)) out.push("Lyft");
  if (/\buber\s*eats\b/.test(lower)) out.push("Uber Eats");
  if (/\buber\b/.test(lower) && !out.includes("Uber Eats")) out.push("Uber");
  else if (/\buber\b/.test(lower) && /\b(rideshare|ride[\s-]?share|\bx\b|comfort|xl)\b/.test(lower) && !out.includes("Uber")) {
    out.push("Uber");
  }
  if (/\bdoordash\b|\bdoor\s*dash\b/.test(lower)) out.push("DoorDash");
  if (/\bgrubhub\b/.test(lower)) out.push("Grubhub");
  if (/\binstacart\b/.test(lower)) out.push("Instacart");
  if (/\broadie\b/.test(lower)) out.push("Roadie");
  if (/\bamazon\s+flex\b/.test(lower)) out.push("Amazon Flex");
  if (/\bshipt\b/.test(lower)) out.push("Shipt");
  return out;
}

/**
 * Prefer official help-site searches (Texas / DFW for Blake).
 */
function platformEligibilitySearchQueries(message) {
  const lower = String(message || "").toLowerCase();
  const platforms = detectPlatformsInMessage(message);
  const queries = [];
  const push = (q) => {
    const t = String(q || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    if (queries.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    queries.push(t);
  };

  if (platforms.includes("Lyft") || (!platforms.length && /\blyft\b/.test(lower))) {
    push("Lyft Texas vehicle requirements model year site:help.lyft.com");
    push("Lyft Texas Driver Information vehicle year site:help.lyft.com");
  }
  if (platforms.includes("Uber") || (/\buber\b/.test(lower) && !platforms.includes("Uber Eats"))) {
    push("Uber Dallas Fort Worth vehicle requirements years");
    push("Uber vehicle requirements Dallas Fort Worth site:www.uber.com OR site:help.uber.com");
  }
  if (platforms.includes("Uber Eats")) {
    push("Uber Eats vehicle requirements model year Texas");
  }
  if (platforms.includes("DoorDash")) {
    push("DoorDash dasher vehicle requirements age eligibility");
  }
  if (platforms.includes("Grubhub")) push("Grubhub driver vehicle requirements");
  if (platforms.includes("Instacart")) push("Instacart shopper vehicle requirements");
  if (platforms.includes("Roadie")) push("Roadie driver vehicle requirements");
  if (platforms.includes("Amazon Flex")) push("Amazon Flex vehicle requirements");
  if (platforms.includes("Shipt")) push("Shipt shopper vehicle requirements");

  if (!queries.length) {
    push("rideshare delivery platform vehicle age requirements Texas model year");
  }
  return queries.slice(0, 3);
}

const OFFICIAL_POLICY_HOSTS = [
  "help.lyft.com",
  "lyft.com",
  "help.uber.com",
  "uber.com",
  "help.doordash.com",
  "doordash.com",
  "help.grubhub.com",
  "roadie.com",
  "flex.amazon.com",
  "shoppers.instacart.com",
  "shipt.com"
];

module.exports = {
  isPlatformEligibilityAsk,
  detectPlatformsInMessage,
  platformEligibilitySearchQueries,
  PLATFORM_RE,
  ELIGIBILITY_TOPIC_RE,
  OFFICIAL_POLICY_HOSTS
};
