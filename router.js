"use strict";

/**
 * Deterministic intent router for AIPickVault Desktop.
 *
 * routeMessage(message) -> { intent, payload }
 *
 * Intents:
 *   stock_compare | stock | weather | news | fetch | search | chat
 *
 * ---------------------------------------------------------------------------
 * Priority (first match wins) — keep this order in code and tests:
 *
 *   1. stock_compare  explicit "compare X vs Y"
 *   2. stock          1–5 letter tickers, $TICKER, aliases with market context
 *   3. weather        requires weather context (NOT bare high / low / rain)
 *   4. news           news / headlines / breaking news
 *   5. fetch          http(s)/www/webpage review + domain
 *   6. search         explicit research / lookup / live product questions
 *   7. chat           conversation, identity, how-to — do not force a tool
 *
 * ---------------------------------------------------------------------------
 * Architecture (Grok-like path; identity stays AIPickVault Desktop):
 *
 * - Cheap and sync so unit tests do not need Ollama or paid APIs.
 * - payload.tools is a hint list for this turn. researchLoop.planTools() turns
 *   that into an ordered 1–3 step plan (search → news → optional finance).
 *   Handlers run the loop: plan → execute (sequential / limited parallel) →
 *   synthesize one cited answer. Chat / pure chitchat skips the loop.
 * - Streaming can wrap the same intents; routing stays out of the token path.
 * - Chat provider (askOllama today) is behind a (prompt, model) interface so
 *   an xAI adapter can swap in later. Never claim to be Grok in prompts.
 */

const DEFAULT_WEATHER_LOCATION = "Fort Worth";

const STOCK_ALIASES = {
  aapl: "AAPL",
  apple: "AAPL",
  msft: "MSFT",
  microsoft: "MSFT",
  goog: "GOOG",
  googl: "GOOG",
  google: "GOOG",
  amzn: "AMZN",
  amazon: "AMZN",
  tsla: "TSLA",
  tesla: "TSLA",
  nvda: "NVDA",
  nvidia: "NVDA",
  meta: "META",
  facebook: "META",
  fb: "META"
};

// Tokens that look like 1–5 letter tickers but are normal English / other intents.
const TICKER_STOPWORDS = new Set([
  "A", "I", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "IF", "IN",
  "IS", "IT", "ME", "MY", "NO", "OF", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER", "WAS",
  "ONE", "OUR", "OUT", "DAY", "GET", "HAS", "HEY", "HI", "HIM", "HIS", "HOW", "MAN", "NEW",
  "NOW", "OLD", "SEE", "TWO", "WAY", "WHO", "BOY", "DID", "ITS", "LET", "PUT",
  "SAY", "SHE", "TOO", "USE", "WHY", "YES", "YET", "ANY", "ASK", "BIG", "FEW",
  "GOT", "HAD", "HOT", "MAY", "OWN", "TRY", "BEST", "FROM", "HAVE", "JUST",
  "KNOW", "LIKE", "MAKE", "MORE", "ONLY", "OVER", "SOME", "THAN", "THAT",
  "THEM", "THEN", "THIS", "WHAT", "WHEN", "WILL", "WITH", "YOUR", "ABOUT",
  "NEWS", "HIGH", "LOW", "RAIN", "SNOW", "WIND", "TEMP", "CHAT", "HELP",
  "CODE", "HTML", "JSON", "HTTP", "OPEN", "CLOSE", "PRICE", "FIND", "LOOK",
  "AI", "GPU", "CPU", "API", "USA", "USB", "PDF", "CSS", "SQL", "AWS",
  "CEO", "CTO", "IPO", "ETF"
]);

const KNOWN_CITIES = [
  "fort worth",
  "dallas",
  "austin",
  "houston",
  "san antonio",
  "el paso",
  "arlington",
  "plano",
  "irving",
  "new york",
  "los angeles",
  "chicago",
  "miami",
  "seattle",
  "denver",
  "phoenix",
  "atlanta",
  "boston",
  "london",
  "paris"
];

function normalize(message) {
  return String(message || "").trim();
}

function isPlausibleTicker(token) {
  const t = String(token || "").trim();
  if (!/^[A-Za-z]{1,5}$/.test(t)) return false;
  return !TICKER_STOPWORDS.has(t.toUpperCase());
}

function resolveTokenToSymbol(token) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const alias = STOCK_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (isPlausibleTicker(raw)) return raw.toUpperCase();
  return null;
}

function findAlias(lower) {
  const keys = Object.keys(STOCK_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (new RegExp(`\\b${key}\\b`, "i").test(lower)) {
      return STOCK_ALIASES[key];
    }
  }
  return null;
}

function isKnownTickerToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return false;
  if (STOCK_ALIASES[raw.toLowerCase()]) return true;
  const upper = raw.toUpperCase();
  return Object.values(STOCK_ALIASES).includes(upper);
}

function extractExplicitTicker(message, lower) {
  const trimmed = normalize(message);
  if (!trimmed) return null;

  const dollar = trimmed.match(/\$([A-Za-z]{1,5})\b/);
  if (dollar) {
    const resolved = resolveTokenToSymbol(dollar[1]);
    if (resolved) return resolved;
  }

  const whole = resolveTokenToSymbol(trimmed);
  if (whole) return whole;

  // All-caps sentences ("HOW ARE YOU") are not a bag of tickers.
  const shouting = trimmed === trimmed.toUpperCase() && /\s/.test(trimmed);
  if (!shouting) {
    const stockCtx = hasStockContext(lower || trimmed.toLowerCase());
    const caps = trimmed.match(/\b[A-Z]{1,5}\b/g) || [];
    for (const token of caps) {
      const resolved = resolveTokenToSymbol(token);
      if (!resolved) continue;
      // In-sentence caps only count as tickers when known (AAPL/NVDA) or
      // the user already used stock language. Avoid "AI" / "USA" false hits.
      if (stockCtx || isKnownTickerToken(token)) return resolved;
    }
  }

  return null;
}

function resolveCompareSide(text) {
  return resolveTokenToSymbol(text);
}

function extractCompareSymbols(message) {
  const lower = message.toLowerCase();
  if (!lower.startsWith("compare ") || !/\svs\s/.test(lower)) return null;

  const rest = message.replace(/^compare\s+/i, "");
  const parts = rest.split(/\s+vs\s+/i);
  if (parts.length < 2) return null;

  const symbol1 = resolveCompareSide(parts[0]);
  const symbol2 = resolveCompareSide(parts[1]);
  if (!symbol1 || !symbol2) return null;
  return [symbol1, symbol2];
}

function hasStockContext(lower) {
  return /\b(stocks?|tickers?|share prices?|shares of|stock ?market|djia|dow jones|\bdow\b|nasdaq|s&p|sp ?500|nyse|earnings)\b/i.test(
    lower
  );
}

function matchStock(text, lower) {
  const whole = STOCK_ALIASES[text.trim().toLowerCase()];
  if (whole) return { symbol: whole };

  const ticker = extractExplicitTicker(text, lower);
  if (ticker) return { symbol: ticker };

  const alias = findAlias(lower);

  if (hasStockContext(lower)) {
    return { symbol: alias || null };
  }

  // "what's happening with nvidia" / "price of tesla" — market ask + alias
  if (alias && /\b(what(?:'s| is) happening|price of)\b/i.test(lower)) {
    return { symbol: alias };
  }

  return null;
}

const STRONG_WEATHER =
  /\b(weather|forecast|temperature|humidity|humid|precipitation|barometer|fahrenheit|celsius|windy|wind\s*chill|wind\s*speed|umbrella)\b/i;
const TEMP_WORD = /\btemps?\b/i;
const DEGREES = /°\s*[fc]\b|\bdegrees\s*(?:f|c|fahrenheit|celsius)?\b/i;
const PRECIP =
  /\b(rain(?:ing|y)?|snow(?:ing|y)?|storm(?:y|s)?|thunder(?:storm)?s?|lightning|hail|sleet|drizzle|blizzard|downpour)\b/i;
const PRECIP_VERB = /\b(raining|snowing|storming)\b/i;
const WEAK_HIGH_LOW = /\b(highs?|lows?)\b/i;
const WIND = /\bwind(?:s|y)?\b/i;
const TIME_HINT =
  /\b(today|tonight|tomorrow|weekend|this\s+week|this\s+afternoon|this\s+morning|outside)\b/i;

function titleCaseCity(name) {
  return String(name)
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function hasLocation(message, lower) {
  if (KNOWN_CITIES.some((city) => lower.includes(city))) return true;
  return /\bin\s+[A-Za-z]{2,}/.test(message);
}

function extractLocation(message) {
  const lower = message.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city)) return titleCaseCity(city);
  }

  const titled = message.match(
    /\bin\s+([A-Z][a-z]+(?:[\s-][A-Z][a-z]+){0,3})\b/
  );
  if (titled) return titled[1];

  const any = message.match(
    /\bin\s+([A-Za-z][A-Za-z\s-]{1,40}?)(?:\s+(?:today|tomorrow|tonight|right now|please)[,.?]?$|[,.?]|$)/i
  );
  if (any) {
    const loc = any[1].trim();
    if (loc && !/^(the|a|an|my)\b/i.test(loc)) return titleCaseCity(loc);
  }

  return DEFAULT_WEATHER_LOCATION;
}

function isWeatherIntent(message, lower) {
  if (STRONG_WEATHER.test(lower) || TEMP_WORD.test(lower) || DEGREES.test(lower)) {
    return true;
  }

  const precip = PRECIP.test(lower);
  const wind = WIND.test(lower);
  const highLow = WEAK_HIGH_LOW.test(lower);
  const loc = hasLocation(message, lower);
  const time = TIME_HINT.test(lower);

  // Verb forms are specific ("is it raining?") — not the bare noun "rain".
  if (PRECIP_VERB.test(lower)) return true;

  // rain/snow need extra weather context, never the word alone.
  if (
    precip &&
    (loc || time || /will it|going to|is it|chance of/i.test(lower))
  ) {
    return true;
  }

  if (
    wind &&
    (loc || time || precip || /\bspeed\b|\bchill\b/i.test(lower))
  ) {
    return true;
  }

  // high/low NEVER with only "today" — that was the main false positive.
  // Require a city, degrees, or another real weather term.
  if (
    highLow &&
    (loc || precip || TEMP_WORD.test(lower) || DEGREES.test(lower) || STRONG_WEATHER.test(lower))
  ) {
    return true;
  }

  return false;
}

function isNewsIntent(lower) {
  if (/\bheadlines?\b/i.test(lower)) return true;
  if (/\bbreaking\s+news\b/i.test(lower)) return true;
  if (!/\bnews\b/i.test(lower)) return false;

  if (/\bi have\b.*\bnews\b/i.test(lower)) return false;
  if (
    /\b(good|bad|great|sad)\s+news\b/i.test(lower) &&
    !/\b(latest|today|tech|ai|world|sports|business|headlines?)\b/i.test(lower)
  ) {
    return false;
  }

  return true;
}

function newsTopic(lower) {
  if (/\bai\b|artificial intelligence/.test(lower)) return "artificial intelligence";
  if (/\btech/.test(lower)) return "technology";
  if (/\bgaming\b/.test(lower)) return "gaming";
  if (/\bbusiness\b/.test(lower)) return "business";
  if (/\bsports\b/.test(lower)) return "sports";
  return "technology";
}

function normalizeUrlCandidate(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/^<|>$/g, "")
    .replace(/[)\],.!?;:'"]+$/g, "");
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return "https:" + s;
  if (/^www\./i.test(s)) return "https://" + s;
  // bare domain.tld or domain.tld/path
  if (
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s]*)?$/i.test(
      s
    )
  ) {
    return "https://" + s;
  }
  return null;
}

function extractUrlsFromMessage(message) {
  const text = String(message || "");
  const found = [];
  const seen = new Set();
  const push = (u) => {
    const n = normalizeUrlCandidate(u);
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(n);
  };

  let m;
  const reHttp = /https?:\/\/[^\s<>"']+/gi;
  while ((m = reHttp.exec(text))) push(m[0]);

  const reWww = /\bwww\.[^\s<>"']+/gi;
  while ((m = reWww.exec(text))) push(m[0]);

  const look = text.match(
    /\b(?:take a\s+)?look at\s+(?:my\s+)?(?:web\s*)?(?:page|site|website)\s*[:\-]?\s*([^\s]+)/i
  );
  if (look) push(look[1]);

  const check = text.match(
    /\b(?:check out|review|analyze|open)\s+(?:my\s+)?(?:web\s*)?(?:page|site|website)\s*[:\-]?\s*([^\s]+)/i
  );
  if (check) push(check[1]);

  // With webpage/site language, also pick bare domains (e.g. wethepeoplepress.com).
  if (
    /\b(web\s*page|webpage|website|web\s*site|my\s+site|my\s+page)\b/i.test(text) ||
    (/\b(look at|check out|review|what do you think)\b/i.test(text) &&
      /\b(page|site|website)\b/i.test(text))
  ) {
    const bare =
      text.match(
        /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[^\s]*)?)\b/gi
      ) || [];
    for (const b of bare) {
      // skip common false positives
      if (/^(e\.g|i\.e|vs\.|etc)\b/i.test(b)) continue;
      push(b);
    }
  }

  return found;
}

function isWebpageReviewIntent(message, lower) {
  const urls = extractUrlsFromMessage(message);
  if (/https?:\/\//i.test(message) || /\bwww\./i.test(lower)) {
    return urls.length > 0;
  }
  if (
    /\b(?:take a\s+)?look at\s+(?:my\s+)?(?:web\s*)?(?:page|site|website)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(?:check out|review|analyze|feedback on)\s+(?:my\s+)?(?:web\s*)?(?:page|site|website)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    urls.length > 0 &&
    /\b(what do you think|review|feedback|analyze|critique)\b/i.test(lower) &&
    /\b(page|site|website|webpage)\b/i.test(lower)
  ) {
    return true;
  }
  return false;
}

function isPureChitchat(lower) {
  if (/^(hi|hello|hey|thanks|thank you|good morning|good night)(?:[\s,.!]|$)/i.test(lower)) {
    return true;
  }
  if (
    /\b(who are you|what(?:'s| is) your name|your (?:name|primary function))\b/i.test(
      lower
    )
  ) {
    return true;
  }
  return false;
}

function isChatish(lower) {
  if (
    /\b(who are you|what(?:'s| is) your name|your (?:name|primary function)|how do you work)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (/^(hi|hello|hey|thanks|thank you|good morning|good night)\b/.test(lower)) {
    return true;
  }
  if (
    /\b(how does|how do i|how to|explain|write me|write a python|what does .{1,40} mean)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Follow-ups that need live tools (not pure chat), even mid-conversation:
 * recalls/NHTSA, prices/listings, insurance quotes, availability, or
 * challenging a prior recommendation.
 */
function needsFactualRefresh(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower.trim()) return false;

  // Safety / recalls / NHTSA
  if (/\b(recalls?|nhtsa|safety\s+campaign|campaign\s*(?:id|number)|takata)\b/i.test(lower)) {
    return true;
  }
  if (
    /\bbattery\s+recall\b/i.test(lower) ||
    (/\bgeneration\b/i.test(lower) && /\b(prius|hybrid|battery)\b/i.test(lower))
  ) {
    return true;
  }

  // Prices, listings, availability
  if (
    /\b(listings?|for\s+sale|asking\s+price|market\s+value|fair\s+price|autotrader|cars\.com|cargurus|carvana|availability|in\s+stock|dealer\s+(?:price|inventory)|verified\s+at\s+dealer)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(how\s+much\s+(?:do|does|is|are)|what(?:'s| is)\s+(?:the\s+)?(?:price|cost)|prices?\b)/i.test(
      lower
    ) &&
    /\b(car|truck|suv|vehicle|prius|van|hybrid|sedan|insurance)\b/i.test(lower)
  ) {
    return true;
  }

  // Insurance quotes
  if (/\binsurance\b/i.test(lower) && /\b(quote|quotes|cost|rate|premium|how\s+much)\b/i.test(lower)) {
    return true;
  }

  // Challenge prior recommendation / ask to verify something specific
  if (
    /\b(did you (?:consider|check|look\s*up|verify|account\s+for)|are you sure|is that (?:true|accurate|correct|right)|you (?:said|claimed|recommended|mentioned)|verify that)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /\b(what about|how about)\b/i.test(lower) &&
    /\b(recall|nhtsa|price|listing|insurance|battery|generation|maintenance|reliability|mpg|tire|availability)\b/i.test(
      lower
    )
  ) {
    return true;
  }

  return false;
}

function isSearchIntent(text, lower) {
  // Factual refresh beats chitchat heuristics (recall / price / challenge follow-ups).
  if (needsFactualRefresh(text)) return true;
  if (isChatish(lower)) return false;

  if (/^(search|look\s*up|lookup|find|google)\b/i.test(text)) return true;
  if (/\b(search for|look up|look it up)\b/i.test(lower)) return true;
  // Shop / product lookup (Amazon, Walmart, magnets, etc.)
  if (/\b(amazon|walmart|best\s*buy|home\s*depot|ebay)\b/i.test(lower) && /\b(check|search|find|look|buy|price|product|for me)\b/i.test(lower)) {
    return true;
  }
  if (/\b(neodymium|magnet|retrieval|pickup tool|products? you find)\b/i.test(lower) && /\b(amazon|walmart|shop|buy|find|check)\b/i.test(lower)) {
    return true;
  }
  // Year-recall for gig Corolla/Prius
  if (
    (/\b(forgot|what|which|remind)\b[\s\S]{0,40}\byears?\b/i.test(lower) || /\bforgot\s+what\s+years?\b/i.test(lower)) &&
    /\b(corollas?|corrolas?|carollas?|prius|civic|gig|delivery)\b/i.test(lower)
  ) {
    return true;
  }
  // Locate recommended vehicle
  if (
    /\b(locate|find|help\s+me\s+find)\b/i.test(lower) &&
    /\b(corollas?|corrolas?|carollas?|prius|toyota|recommended|you\s+recommended)\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /\b(what(?:'s| is) happening|latest on|current events|who won)\b/i.test(lower)
  ) {
    return true;
  }
  if (
    /\b(cheapest|where (?:can|do) i buy|best used|under \$?\d+)/i.test(lower)
  ) {
    return true;
  }
  if (
    /\b(should i buy|what (?:vehicle|car|truck|suv|hybrid)|which (?:vehicle|car))\b/i.test(
      lower
    )
  ) {
    return true;
  }
  return false;
}

function extractSearchQuery(message) {
  const stripped = message
    .replace(/^(search\s+for|search|look\s*up|lookup|find|google)\s+/i, "")
    .trim();
  return stripped || message.trim();
}

function shouldAlsoSearchNews(lower) {
  return /\b(latest|happening|current|today|breaking|recall|nhtsa)\b/.test(lower);
}

function wantsRecommendation(lower) {
  return (
    /\bbest\b/.test(lower) ||
    /\brecommend/.test(lower) ||
    /\bshould i buy\b/.test(lower) ||
    /\bwhat (?:vehicle|car|truck|suv|hybrid)\b/.test(lower) ||
    /\bwhich (?:vehicle|car)\b/.test(lower)
  );
}

function routeMessage(message) {
  const text = normalize(message);
  const lower = text.toLowerCase();
  const rec = wantsRecommendation(lower);

  // Greetings / identity skip the tool loop entirely.
  if (isPureChitchat(lower)) {
    return {
      intent: "chat",
      payload: { tools: [], wantsRecommendation: rec }
    };
  }

  const compare = extractCompareSymbols(text);
  if (compare) {
    return {
      intent: "stock_compare",
      payload: { symbols: compare, tools: ["stock", "news"] }
    };
  }

  const stock = matchStock(text, lower);
  if (stock) {
    return {
      intent: "stock",
      payload: { symbol: stock.symbol, tools: ["stock", "news"] }
    };
  }

  if (isWeatherIntent(text, lower)) {
    return {
      intent: "weather",
      payload: {
        location: extractLocation(text),
        tools: ["weather"]
      }
    };
  }

  if (isNewsIntent(lower)) {
    return {
      intent: "news",
      payload: { topic: newsTopic(lower), tools: ["news"] }
    };
  }

  if (isWebpageReviewIntent(text, lower)) {
    const urls = extractUrlsFromMessage(text);
    return {
      intent: "fetch",
      payload: {
        url: urls[0] || null,
        urls,
        tools: ["fetch"],
        query: text
      }
    };
  }

  if (isSearchIntent(text, lower)) {
    const tools = ["search"];
    if (shouldAlsoSearchNews(lower) || /\b(recall|nhtsa)\b/i.test(lower)) {
      tools.push("news");
    }
    const forceRefresh = needsFactualRefresh(text);
    // Optional finance step only for real market asks — not vehicle price/recall refreshes.
    const optionalSymbol = findAlias(lower);
    if (
      optionalSymbol &&
      tools.length < 3 &&
      !forceRefresh &&
      /\b(stock|shares?|market|earnings|ticker)\b/i.test(lower)
    ) {
      tools.push("stock");
    }
    return {
      intent: "search",
      payload: {
        query: extractSearchQuery(text),
        tools,
        wantsRecommendation: rec,
        forceToolRefresh: forceRefresh || undefined,
        optionalSymbol: optionalSymbol || undefined
      }
    };
  }

  return {
    intent: "chat",
    payload: { tools: [], wantsRecommendation: rec }
  };
}

module.exports = {
  routeMessage,
  needsFactualRefresh,
  extractUrlsFromMessage,
  isWebpageReviewIntent,
  STOCK_ALIASES,
  DEFAULT_WEATHER_LOCATION
};
