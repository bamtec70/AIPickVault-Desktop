"use strict";

const {
  shouldUseKnowledgeFirst,
  domainPackPromptSection,
  loadGigVehicleDomainPack
} = require("./domain/gigVehicle");
const { needsFactualRefresh } = require("./router");

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
    /\bunder\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bbelow\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\bless\s+than\s+\$?\s*([\d,]+(?:\.\d+)?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)/,
    /\b([\d,]+)\s*k\s*(?:budget|max|maximum|or\s+less)?\b/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    let n = parseFloat(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/\bk\b/i.test(m[0])) n = Math.round(n * 1000);
    if (n >= 100) return Math.round(n);
  }
  return null;
}

function extractGigUseCase(message) {
  const lower = String(message || "").toLowerCase();
  const platforms = [];
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
  return /\b(car|truck|suv|vehicle|hybrid|sedan|hatchback|minivan|civic|corolla|prius|cargo\s+van|van)\b/i.test(
    String(message || "")
  );
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

  // Recall / NHTSA / battery follow-ups — tight factual queries first
  if (/\b(recall|nhtsa)\b/i.test(text) || (/\bbattery\b/i.test(text) && /\b(prius|toyota|hybrid|generation)\b/i.test(text))) {
    const modelBit = (text.match(/\b(prius|corolla|civic|camry|accord|rav4|sienna)\b/i) || [])[0] || "used car";
    queries.push(`${modelBit} hybrid battery recall NHTSA`);
    queries.push(`${modelBit} generations years battery recall affected`);
    if (/\bgeneration\b/i.test(text)) {
      queries.push(`Toyota Prius gen 2 gen 3 gen 4 hybrid battery reliability`);
    }
  }

  if ((wantsRec || looksLikeEssay) && (vehicle || gig.isGig)) {
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
    if (knowledgeFirst && !forceRefresh) {
      return [{
        id: "domain",
        tool: "domain",
        label: "Gig-vehicle domain pack",
        args: {},
        knowledgeFirst: true
      }];
    }
    const multiAngle = !knowledgeFirst && wantsRec && (costRel || rewritten.gig.isGig || isVehicleAsk(rawQuery));

    if (toolsHint.includes("search") || toolsHint.length === 0) {
      const primary = queryList[0] || rawQuery;
      steps.push({
        id: "search", tool: "search", label: "Web search",
        args: { query: primary },
        queryMeta: { original: rawQuery, rewritten: primary, wasRewritten: rewritten.rewritten }
      });
    }

    if (wantsRec && steps.some((s) => s.tool === "search")) {
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

    const minSteps = multiAngle ? 3 : wantsRec ? 2 : 1;
    while (wantsRec && steps.length < minSteps && steps.length < MAX_STEPS && steps.some((s) => s.tool === "search")) {
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
    if (tool === "weather") {
      const result = await toolFns.getWeather(args.location);
      if (isToolError(result)) return { ok: false, kind: "weather", data: result, error: result && result.error };
      return { ok: true, kind: "weather", data: result };
    }
    return { ok: false, kind: "unknown", data: null, error: `Unknown tool: ${tool}` };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { ok: false, kind: tool, data: tool === "stock" || tool === "weather" ? null : [], error: msg };
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
  } else if (outcome.kind === "weather") {
    bag.weather = outcome.data;
  }
  if (!outcome.ok && outcome.error) {
    bag.errors.push({ step: step.id, tool: step.tool, error: String(outcome.error) });
  }
}

function buildSynthesisPrompt(message, intent, bag, wantsRecommendation) {
  const parts = [];
  const gig = extractGigUseCase(message);
  const criteria = extractCriteria(message);
  const budget = extractBudget(message);
  const vehicle = isVehicleAsk(message);

  parts.push(`You are a sharp local advisor for Blake in the Fort Worth / Alliance area (76177), Texas. Think hard, then answer decisively.`);
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
  parts.push(`- Do not invent NHTSA recall campaign IDs unless present in tool text; if unsure, say so and rely on what the sources show.`);
  parts.push(`- ANTI-FAKE-STATS: Never invent SOH percentages, failure probabilities, \"X% of cars\", reliability index scores (e.g. 3.2/5.0), or precise chance-of-failure numbers unless those exact figures appear in the tool result text below. Prefer qualitative: \"battery health varies; require PPI / SOH report.\"`);
  parts.push(`- Do not over-claim NHTSA sourcing. If campaign details are not in tool snippets, say you do not have the campaign text — do not fabricate IDs or rates.`);
  parts.push(`- Rough annual cost buckets (fuel, insurance, maintenance, tires) OK if labeled estimates with uncertainty. No fake precision. Do NOT double-count buckets (e.g. tires twice).`);
  parts.push(`- If sources are thin/spammy, still advise like a decisive courier-aware local using solid US used-car knowledge. Do not apologize about tools.`);
  parts.push(`- Ban nonsense: do NOT call mainstream US-market cars (Honda, Toyota, Hyundai, Kia, etc.) "foreign imports to avoid." Judge reliability, parts cost, MPG.`);
  parts.push(`- No raw JSON. Short structured sections.`);

  if (wantsRecommendation || vehicle || gig.isGig) {
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

  if (vehicle || gig.isGig || wantsRecommendation || bag.domainPack) {
    parts.push(``);
    parts.push(`Knowledge-first mode: reason from the local domain pack + durable memory first. Use tool results only to verify live facts (recalls, prices, listings, insurance). Do not invent listings.`);
    parts.push(domainPackPromptSection());
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
  const steps = planTools(route, message);
  const wantsRecommendation = !!(route.payload && route.payload.wantsRecommendation);
  const skipSynthesize = !!opts.skipSynthesize;

  if (!steps.length) {
    return { text: "", model, plan: [], bag: { web: null, news: null, stocks: {}, weather: null, domainPack: null, errors: [] }, skipped: true };
  }

  const bag = { web: null, news: null, stocks: {}, weather: null, domainPack: null, errors: [] };

  for (const s of steps) {
    if (s.queryMeta && s.queryMeta.wasRewritten) {
      stream.note(`Query rewrite: "${String(s.queryMeta.original || "").slice(0, 80)}" â†’ "${s.args.query}"`);
    } else if (s.tool === "search" && s.args && s.args.query) {
      stream.note(`Search query: "${s.args.query}"`);
    }
  }

  stream.note(`Research plan (${steps.length} step${steps.length === 1 ? "" : "s"}): ${describePlan(steps)}`);

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
        }
      } else {
        stream.note(`${s.label} unavailable${outcome.error ? ": " + String(outcome.error).slice(0, 80) : ""}. Continuing…`);
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
  const hasDomain = !!(bag.domainPack && String(bag.domainPack).length > 40);
  const hasAny = citations > 0 || hasStock || hasWeather || hasDomain;

  if (skipSynthesize) return { text: "", model, plan: steps, bag, gathered: true };

  const askOpts = { think: !!opts.think };

  if (!hasAny) {
    if (wantsRecommendation && typeof askOllama === "function") {
      stream.note("Drafting a practical recommendation…");
      const text = await askOllama(buildSynthesisPrompt(message, route.intent, bag, true), model, stream.chunk, askOpts);
      return { text, model, plan: steps, bag };
    }
    const failBits = bag.errors.map((e) => e.error).filter(Boolean);
    const text = failBits.length > 0
      ? `I couldn't retrieve reliable live data right now (${failBits[0]}). Check API keys in .env and try again.`
      : "I couldn't retrieve reliable live data right now. Please try again in a moment.";
    return { text, model, plan: steps, bag };
  }

  const packOnlySynth = hasDomain && citations === 0 && !hasStock && !hasWeather;
  if (packOnlySynth) {
    stream.note("Using gig-vehicle specialist knowledge…");
  } else {
    stream.note(`Synthesizing from ${citations || "tool"} source${citations === 1 ? "" : "s"}…`);
  }
  const prompt = buildSynthesisPrompt(message, route.intent, bag, wantsRecommendation);
  const text = await askOllama(prompt, model, stream.chunk, askOpts);
  return { text, model, plan: steps, bag };
}

module.exports = {
  planTools, runResearchLoop, formatWebResults, formatNewsResults, refineNewsTopic,
  describePlan, rewriteSearchQuery, rewriteNewsTopic, resultsSeemThinOrOffTopic,
  buildSynthesisPrompt, extractBudget, extractGigUseCase, extractCriteria,
  hasCostReliabilityLanguage, rankWebResultsForSynth, scoreWebResultForSynth, MAX_STEPS,
  shouldUseKnowledgeFirst
};
