"use strict";

/**
 * Multi-step research agent loop for AIPickVault Desktop.
 *
 * planTools(route, message) -> ordered steps (1–3)
 * runResearchLoop(...)      -> execute tools (sequential / limited parallel)
 *                            -> stream progress notes
 *                            -> synthesize one cited answer via Ollama
 *
 * Chat intents should skip this loop (empty plan).
 */

const MAX_STEPS = 3;

/** Stopwords stripped when rewriting long questions into search keywords. */
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "from",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "that", "thats", "that's", "this", "these", "those", "it", "its", "it's",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "what", "whats", "what's", "which", "who", "whom", "whose", "where", "when",
  "why", "how", "can", "could", "would", "should", "will", "shall", "may",
  "might", "must", "need", "use", "using", "used", "get", "got", "have", "has",
  "had", "and", "or", "but", "if", "then", "than", "so", "as", "into", "about",
  "there", "here", "just", "also", "really", "very", "please", "tell", "give",
  "find", "show", "some", "any", "all", "each", "every", "both", "few", "more",
  "most", "other", "such", "only", "own", "same", "too", "s", "t", "ve",
  "re", "ll", "d", "m"
]);

/**
 * Turn a long natural-language question into 1–2 tight keyword queries.
 * Never pass a raw essay to SerpAPI when the ask is recommendation/how-to.
 *
 * @param {string} message
 * @param {{ wantsRecommendation?: boolean }} [opts]
 * @returns {{ primary: string, alternate: string|null, rewritten: boolean }}
 */
function rewriteSearchQuery(message, opts) {
  const wantsRec = !!(opts && opts.wantsRecommendation);
  const raw = String(message || "").trim();
  if (!raw) return { primary: "", alternate: null, rewritten: false };

  // Strip leading search verbs so "search for X" stays "X"
  let text = raw
    .replace(/^(search\s+for|search|look\s*up|lookup|find|google)\s+/i, "")
    .trim();

  // Normalize currency / budget phrases before tokenization
  text = text
    .replace(/\$\s*([\d,]+(?:\.\d+)?)\s*k\b/gi, (m, n) => `under ${n}000`)
    .replace(/\$\s*([\d,]+(?:\.\d+)?)/g, "$$$1")
    .replace(/\bunder\s+\$?\s*([\d,]+)/gi, "under $1")
    .replace(/\bbelow\s+\$?\s*([\d,]+)/gi, "under $1")
    .replace(/\bless\s+than\s+\$?\s*([\d,]+)/gi, "under $1")
    .replace(/\b(?:usd|dollars?)\b/gi, "")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = text.split(/\s+/).filter(Boolean);
  const kept = [];
  for (const tok of tokens) {
    const bare = tok.replace(/^[^a-zA-Z0-9$]+|[^a-zA-Z0-9$]+$/g, "");
    if (!bare) continue;
    const lower = bare.toLowerCase();
    // Keep budget markers and numbers
    if (/^\$?\d[\d,]*k?$/i.test(bare) || /^under$/i.test(bare)) {
      kept.push(bare.replace(/,/g, ""));
      continue;
    }
    if (QUERY_STOPWORDS.has(lower)) continue;
    if (bare.length >= 2) kept.push(bare);
  }

  // Dedupe consecutive duplicates (case-insensitive)
  const deduped = [];
  for (const t of kept) {
    if (
      deduped.length &&
      deduped[deduped.length - 1].toLowerCase() === t.toLowerCase()
    ) {
      continue;
    }
    deduped.push(t);
  }

  let primary = deduped.join(" ").trim();
  if (!primary) primary = raw.slice(0, 120);

  // Cap length — SerpAPI likes short queries
  if (primary.split(/\s+/).length > 12) {
    primary = primary.split(/\s+/).slice(0, 12).join(" ");
  }

  const lowerRaw = raw.toLowerCase();
  const looksLikeEssay =
    raw.length > 60 ||
    /\b(what(?:'s| is)|which|how (?:do|to|can)|should i)\b/i.test(raw) ||
    wantsRec;

  let alternate = null;
  if (wantsRec || looksLikeEssay) {
    if (
      /\b(car|truck|suv|vehicle|hybrid|sedan|doordash|uber\s*eats|gig|delivery)\b/i.test(
        lowerRaw
      )
    ) {
      const budget =
        (primary.match(/\bunder\s+\$?\d[\d,]*/i) || [])[0] ||
        (primary.match(/\$\d[\d,]*/i) || [])[0] ||
        "";
      alternate = ["reliable", "cheap", "used", "gig", "delivery", "cars"]
        .concat(budget ? [budget.replace(/\s+/g, " ")] : [])
        .join(" ")
        .trim();
    } else if (/\b(laptop|phone|headphones?|tv|camera|router)\b/i.test(lowerRaw)) {
      alternate = primary
        .replace(/\bbest\b/i, "reliable budget")
        .slice(0, 100);
      if (alternate.toLowerCase() === primary.toLowerCase()) {
        alternate = `reliable affordable ${primary}`.slice(0, 100);
      }
    } else if (wantsRec) {
      alternate = `best options ${primary}`.slice(0, 100);
      if (alternate.toLowerCase() === primary.toLowerCase()) {
        alternate = null;
      }
    }
  }

  const rewritten =
    looksLikeEssay ||
    primary.toLowerCase() !== raw.toLowerCase() ||
    !!alternate;

  // Prefer adding "used" for budget car recs when missing
  if (
    wantsRec &&
    /\b(car|truck|suv|vehicle)\b/i.test(primary) &&
    /\bunder\b|\$\d/i.test(primary) &&
    !/\bused\b/i.test(primary)
  ) {
    primary = primary.replace(/\b(cars?|trucks?|suvs?|vehicles?)\b/i, (m) => `used ${m}`);
  }

  // Ensure "best" stays for recommendation searches when present in original
  if (wantsRec && /\bbest\b/i.test(lowerRaw) && !/\bbest\b/i.test(primary)) {
    primary = `best ${primary}`.trim();
  }

  return { primary: primary.trim(), alternate, rewritten };
}

/**
 * Rewrite a news topic the same way (tight keywords, not the essay).
 */
function rewriteNewsTopic(topic) {
  const { primary } = rewriteSearchQuery(String(topic || ""), {
    wantsRecommendation: false
  });
  return primary || String(topic || "").trim();
}

/**
 * Heuristic: first web results are thin or off-topic vs the ask.
 */
function resultsSeemThinOrOffTopic(webResults, message, query) {
  if (!Array.isArray(webResults) || webResults.length === 0) return true;
  if (webResults.length < 3) return true;

  const lowerMsg = String(message || "").toLowerCase();
  const constraintHints = [];
  const budget =
    lowerMsg.match(/\bunder\s+\$?\s*([\d,]+)/i) || lowerMsg.match(/\$\s*([\d,]+)/);
  if (budget) constraintHints.push(budget[1].replace(/,/g, ""));
  if (/\bdoordash\b/i.test(lowerMsg)) {
    constraintHints.push("doordash", "door dash", "delivery");
  }
  if (/\buber\s*eats\b/i.test(lowerMsg)) {
    constraintHints.push("uber", "eats", "delivery");
  }
  if (/\b(car|truck|suv|vehicle)\b/i.test(lowerMsg)) {
    constraintHints.push(
      "car",
      "cars",
      "vehicle",
      "used",
      "toyota",
      "honda",
      "ford",
      "hybrid"
    );
  }

  if (constraintHints.length === 0) {
    const qWords = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !QUERY_STOPWORDS.has(w));
    if (qWords.length === 0) return false;
    const blob = webResults
      .map((r) => `${r.title || ""} ${r.snippet || ""}`)
      .join(" ")
      .toLowerCase();
    const hits = qWords.filter((w) => blob.includes(w)).length;
    return hits < Math.min(2, qWords.length);
  }

  const blob = webResults
    .map((r) => `${r.title || ""} ${r.snippet || ""}`)
    .join(" ")
    .toLowerCase();

  const luxuryNoise =
    /\b(highlander|lexus|es\s*300|mercedes|bmw|cadillac|range rover)\b/i.test(
      blob
    ) &&
    !/\bunder\s*\$?\s*10|\$\s*[1-9]\d{3}\b|\bcheap\b|\bbudget\b|\bused\b/i.test(
      blob
    );

  let topicHits = 0;
  for (const h of constraintHints) {
    if (blob.includes(String(h).toLowerCase())) topicHits += 1;
  }
  if (luxuryNoise && budget) return true;
  if (topicHits < 2 && webResults.length <= 5) return true;
  return false;
}

/**
 * Build 1–3 tool steps from the deterministic router payload.
 * @param {{ intent: string, payload?: object }} route
 * @param {string} message
 * @returns {Array<{ id: string, tool: string, label: string, args: object, parallelGroup?: string }>}
 */
function planTools(route, message) {
  const intent = route && route.intent ? route.intent : "chat";
  const payload = (route && route.payload) || {};
  const toolsHint = Array.isArray(payload.tools) ? payload.tools : [];
  const text = String(message || "").trim();
  const wantsRec = !!payload.wantsRecommendation;
  const steps = [];

  if (intent === "chat") return [];

  if (intent === "weather") {
    steps.push({
      id: "weather",
      tool: "weather",
      label: "Weather",
      args: { location: payload.location || "Fort Worth" }
    });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "news") {
    const topic = rewriteNewsTopic(payload.topic || "technology");
    steps.push({
      id: "news",
      tool: "news",
      label: "News",
      args: { topic }
    });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "search") {
    const rawQuery = payload.query || text;
    const rewritten = rewriteSearchQuery(rawQuery, {
      wantsRecommendation: wantsRec
    });
    const primary = rewritten.primary || rawQuery;
    const alternate = rewritten.alternate;

    if (toolsHint.includes("search") || toolsHint.length === 0) {
      steps.push({
        id: "search",
        tool: "search",
        label: "Web search",
        args: { query: primary },
        queryMeta: {
          original: rawQuery,
          rewritten: primary,
          wasRewritten: rewritten.rewritten
        }
      });
    }

    // Recommendations: always plan ≥2 steps (refined second search, and/or news)
    if (wantsRec && steps.some((s) => s.tool === "search")) {
      const secondQ =
        alternate ||
        rewriteSearchQuery(`reliable affordable ${primary}`, {
          wantsRecommendation: true
        }).primary;
      if (secondQ && secondQ.toLowerCase() !== primary.toLowerCase()) {
        steps.push({
          id: "search2",
          tool: "search",
          label: "Web search (refined)",
          args: { query: secondQ },
          mergeWeb: true,
          queryMeta: {
            original: rawQuery,
            rewritten: secondQ,
            wasRewritten: true
          }
        });
      }
    }

    if (toolsHint.includes("news")) {
      const newsTopicBase = rewriteNewsTopic(
        alternate && wantsRec ? alternate : primary
      );
      steps.push({
        id: "news",
        tool: "news",
        label: "News",
        args: { topic: newsTopicBase },
        refineFrom: "search"
      });
    }

    // If recommendation still only has 1 step, force a second search
    if (wantsRec && steps.length < 2 && steps.some((s) => s.tool === "search")) {
      const fallbackQ = alternate || `best options ${primary}`.slice(0, 100);
      steps.push({
        id: "search2",
        tool: "search",
        label: "Web search (refined)",
        args: { query: fallbackQ },
        mergeWeb: true
      });
    }

    // Optional finance when the research query names a known ticker/company
    if (toolsHint.includes("stock") || payload.optionalSymbol) {
      steps.push({
        id: "stock",
        tool: "stock",
        label: "Finance",
        args: { symbol: payload.optionalSymbol || payload.symbol }
      });
    }
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "stock") {
    const symbol = payload.symbol;
    if (symbol) {
      steps.push({
        id: "stock",
        tool: "stock",
        label: "Finance",
        args: { symbol }
      });
    }
    if (toolsHint.includes("news") || symbol) {
      steps.push({
        id: "news",
        tool: "news",
        label: "News",
        args: { topic: symbol || rewriteNewsTopic(text) }
      });
    }
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "stock_compare") {
    const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    const [s1, s2] = symbols;
    if (s1) {
      steps.push({
        id: "stock1",
        tool: "stock",
        label: `Finance (${s1})`,
        args: { symbol: s1 },
        parallelGroup: "quotes"
      });
    }
    if (s2) {
      steps.push({
        id: "stock2",
        tool: "stock",
        label: `Finance (${s2})`,
        args: { symbol: s2 },
        parallelGroup: "quotes"
      });
    }
    if (s1 && s2) {
      steps.push({
        id: "news",
        tool: "news",
        label: "News",
        args: { topic: `${s1} ${s2}` }
      });
    }
    return steps.slice(0, MAX_STEPS);
  }

  return [];
}

function formatWebResults(results) {
  if (!Array.isArray(results) || results.length === 0) return "(none)";
  return results
    .map((r, i) => {
      const title = r.title || "Untitled";
      const link = r.link || r.url || "";
      const snippet = r.snippet || "";
      return `${i + 1}. ${title}\n   Link: ${link}\n   Snippet: ${snippet}`;
    })
    .join("\n\n");
}

function formatNewsResults(news) {
  if (!Array.isArray(news) || news.length === 0) return "(none)";
  return news
    .map((a, i) => {
      const title = a.title || "Untitled";
      const source = a.source || "";
      const url = a.url || a.link || "";
      return `${i + 1}. ${title}\n   Source: ${source}\n   Link: ${url}`;
    })
    .join("\n\n");
}

function isToolError(result) {
  if (result == null) return true;
  if (result.error) return true;
  return false;
}

function asList(result) {
  if (Array.isArray(result)) return result;
  return [];
}

/**
 * Heuristic: refine a news topic from web titles when useful.
 * Never invents URLs — only reuses words from titles / original query.
 */
function refineNewsTopic(originalTopic, webResults) {
  const base = String(originalTopic || "").trim();
  if (!Array.isArray(webResults) || webResults.length === 0) return base;
  const first = webResults[0];
  const title = first && first.title ? String(first.title) : "";
  if (!title || title.length < 8) return base;
  const cleaned = title
    .replace(/[|\-–—].*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
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
  return steps.map((s) => s.label).join(" → ");
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

/**
 * Execute one tool step with graceful missing-key / API failures.
 */
async function executeStep(step, toolFns) {
  const { tool, args } = step;
  try {
    if (tool === "search") {
      const result = await toolFns.webSearch(args.query);
      if (isToolError(result)) {
        return { ok: false, kind: "web", data: [], error: result && result.error };
      }
      return { ok: true, kind: "web", data: asList(result) };
    }
    if (tool === "news") {
      const result = await toolFns.getNews(args.topic);
      if (isToolError(result)) {
        return { ok: false, kind: "news", data: [], error: result && result.error };
      }
      return { ok: true, kind: "news", data: asList(result) };
    }
    if (tool === "stock") {
      if (!args.symbol) {
        return { ok: false, kind: "stock", data: null, error: "No symbol" };
      }
      const result = await toolFns.getStock(args.symbol);
      if (isToolError(result)) {
        return { ok: false, kind: "stock", data: result, error: result && result.error };
      }
      return { ok: true, kind: "stock", data: result, symbol: args.symbol };
    }
    if (tool === "weather") {
      const result = await toolFns.getWeather(args.location);
      if (isToolError(result)) {
        return { ok: false, kind: "weather", data: result, error: result && result.error };
      }
      return { ok: true, kind: "weather", data: result };
    }
    return { ok: false, kind: "unknown", data: null, error: `Unknown tool: ${tool}` };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return {
      ok: false,
      kind: tool,
      data: tool === "stock" || tool === "weather" ? null : [],
      error: msg
    };
  }
}

function mergeStepResult(bag, step, outcome) {
  if (outcome.kind === "web") {
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
  parts.push(
    `Synthesize one clear, useful answer for the user from the tool results below.`
  );
  parts.push(`Rules:`);
  parts.push(`- Lead with the answer. Be direct; no filler.`);
  parts.push(
    `- When you use a web/news source, cite its real title and exact link from the lists below. Never invent URLs.`
  );
  parts.push(
    `- Do NOT invent live prices, headlines, weather numbers, or availability claims that are not in the tool results.`
  );
  parts.push(
    `- If tool results miss the user's budget or constraints, do NOT refuse or dead-end with "no results." Give a clear best-effort answer: practical picks with constraints (reliability, MPG, parts/insurance cost, etc.), label what came from the sources vs general knowledge, and say what the user should verify locally (listings, insurance, platform vehicle requirements).`
  );
  parts.push(
    `- If a tool failed or returned thin/off-topic hits, say so briefly and still help with grounded general knowledge — without fake citations.`
  );
  parts.push(`- No raw JSON. Prefer short structured sections when helpful.`);
  if (wantsRecommendation) {
    parts.push(
      `- If recommending, use Best Choice / Runner Up / Avoid (or Third Choice) and label uncertainty.`
    );
  }
  parts.push(``);
  parts.push(`User question:`);
  parts.push(message);
  parts.push(``);
  parts.push(`Intent: ${intent}`);

  if (bag.web && bag.web.length) {
    parts.push(``);
    parts.push(`Web search results:`);
    parts.push(formatWebResults(bag.web));
  } else if (bag.web) {
    parts.push(``);
    parts.push(`Web search results: (none)`);
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

  if (bag.errors.length) {
    parts.push(``);
    parts.push(`Tool errors (do not invent replacements):`);
    for (const e of bag.errors) {
      parts.push(`- ${e.tool}: ${e.error}`);
    }
  }

  return parts.join("\n");
}

/**
 * Run the multi-step research loop.
 */
async function runResearchLoop(opts) {
  const message = String(opts.message || "");
  const route = opts.route || { intent: "chat", payload: {} };
  const model = opts.model || "qwen3:30b";
  const stream = opts.stream || { note() {}, chunk() {} };
  const askOllama = opts.askOllama;
  const toolFns = opts.tools;

  const steps = planTools(route, message);
  const wantsRecommendation = !!(
    route.payload && route.payload.wantsRecommendation
  );
  const skipSynthesize = !!opts.skipSynthesize;

  if (!steps.length) {
    return {
      text: "",
      model,
      plan: [],
      bag: { web: null, news: null, stocks: {}, weather: null, errors: [] },
      skipped: true
    };
  }

  const bag = {
    web: null,
    news: null,
    stocks: {},
    weather: null,
    errors: []
  };

  // Log rewritten queries for session diagnostics
  for (const s of steps) {
    if (s.queryMeta && s.queryMeta.wasRewritten) {
      stream.note(
        `Query rewrite: "${String(s.queryMeta.original || "").slice(0, 80)}" → "${s.args.query}"`
      );
    } else if (s.tool === "search" && s.args && s.args.query) {
      stream.note(`Search query: "${s.args.query}"`);
    }
  }

  stream.note(
    `Research plan (${steps.length} step${steps.length === 1 ? "" : "s"}): ${describePlan(steps)}`
  );

  let i = 0;
  let stepOrdinal = 0;
  let autoFollowUpDone = false;

  while (i < steps.length) {
    const step = steps[i];
    const group = step.parallelGroup;
    let batch = [step];
    if (group) {
      while (
        i + batch.length < steps.length &&
        steps[i + batch.length].parallelGroup === group
      ) {
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
          stream.note(
            `Step ${stepOrdinal}/${totalLabel}: ${s.label} (refined topic)…`
          );
        } else {
          stream.note(`Step ${stepOrdinal}/${totalLabel}: ${s.label}…`);
        }
      } else {
        const detail =
          s.tool === "search"
            ? ` for "${s.args.query}"`
            : s.tool === "news"
              ? ` on "${s.args.topic}"`
              : s.tool === "stock"
                ? ` ${s.args.symbol || ""}`
                : s.tool === "weather"
                  ? ` for ${s.args.location || ""}`
                  : "";
        stream.note(
          `Step ${stepOrdinal}/${totalLabel}: ${s.label}${detail}…`
        );
      }

      const outcome = await executeStep(s, toolFns);
      mergeStepResult(bag, s, outcome);

      if (outcome.ok) {
        if (outcome.kind === "web") {
          stream.note(
            `Found ${outcome.data.length} web result${outcome.data.length === 1 ? "" : "s"}.`
          );
        } else if (outcome.kind === "news") {
          stream.note(
            `Found ${outcome.data.length} headline${outcome.data.length === 1 ? "" : "s"}.`
          );
        } else if (
          outcome.kind === "stock" &&
          outcome.data &&
          outcome.data.price != null
        ) {
          stream.note(
            `${outcome.symbol}: $${outcome.data.price}` +
              (outcome.data.changePercent != null
                ? ` (${outcome.data.changePercent})`
                : "")
          );
        } else if (
          outcome.kind === "weather" &&
          outcome.data &&
          outcome.data.location
        ) {
          const w = outcome.data;
          const bits = [w.location];
          if (w.current) {
            bits.push(
              `${w.current.temp_f}°F, ${w.current.condition || ""}`.trim()
            );
          }
          stream.note(`Weather loaded: ${bits.join(" — ")}`);
        }
      } else {
        stream.note(
          `${s.label} unavailable${outcome.error ? ": " + String(outcome.error).slice(0, 80) : ""}. Continuing…`
        );
      }

      // After first search: if thin/off-topic and no second search planned, auto-follow-up
      if (
        !autoFollowUpDone &&
        s.tool === "search" &&
        s.id === "search" &&
        outcome.kind === "web" &&
        steps.length < MAX_STEPS &&
        !steps.some((x) => x.id === "search2") &&
        resultsSeemThinOrOffTopic(bag.web, message, s.args.query)
      ) {
        autoFollowUpDone = true;
        const rw = rewriteSearchQuery(message, {
          wantsRecommendation: wantsRecommendation || true
        });
        const followQ =
          rw.alternate ||
          `reliable affordable ${rw.primary || s.args.query}`.slice(0, 100);
        if (
          followQ &&
          followQ.toLowerCase() !== String(s.args.query).toLowerCase()
        ) {
          const follow = {
            id: "search2",
            tool: "search",
            label: "Web search (auto-refined)",
            args: { query: followQ },
            mergeWeb: true
          };
          steps.splice(i + 1, 0, follow);
          stream.note(
            `First results looked thin/off-topic — adding refined search: "${followQ}"`
          );
        }
      }
    } else {
      stepOrdinal += batch.length;
      stream.note(
        `Steps ${stepOrdinal - batch.length + 1}–${stepOrdinal}/${steps.length}: ${batch
          .map((b) => b.label)
          .join(" + ")} (parallel)…`
      );
      const outcomes = await Promise.all(batch.map((s) => executeStep(s, toolFns)));
      outcomes.forEach((outcome, idx) => {
        mergeStepResult(bag, batch[idx], outcome);
        if (
          outcome.ok &&
          outcome.kind === "stock" &&
          outcome.data &&
          outcome.data.price != null
        ) {
          stream.note(
            `${outcome.symbol}: $${outcome.data.price}` +
              (outcome.data.changePercent != null
                ? ` (${outcome.data.changePercent})`
                : "")
          );
        } else if (!outcome.ok) {
          stream.note(`${batch[idx].label} unavailable. Continuing…`);
        }
      });
    }

    i += batch.length;
  }

  const citations = countCitations(bag);
  const hasStock =
    bag.stocks &&
    Object.keys(bag.stocks).some((k) => bag.stocks[k] && !bag.stocks[k].error);
  const hasWeather = bag.weather && !bag.weather.error;
  const hasAny = citations > 0 || hasStock || hasWeather;

  if (skipSynthesize) {
    return { text: "", model, plan: steps, bag, gathered: true };
  }

  if (!hasAny) {
    if (wantsRecommendation && typeof askOllama === "function") {
      stream.note("No live sources — drafting a cautious recommendation…");
      const text = await askOllama(
        `Give a practical recommendation for the user. Be direct. Label uncertainty. Do not invent live prices, availability, or URLs.
If the ask has a budget or use-case (e.g. gig delivery under $10k), still suggest best-effort picks with constraints (reliability, MPG, parts, insurance) and say what to verify.

User question:
${message}

Provide:
Best Choice: …
Runner Up: …
Third Choice: …
Avoid: …`,
        model,
        stream.chunk
      );
      return { text, model, plan: steps, bag };
    }

    const failBits = bag.errors.map((e) => e.error).filter(Boolean);
    const text =
      failBits.length > 0
        ? `I couldn't retrieve reliable live data right now (${failBits[0]}). Check API keys in .env and try again.`
        : "I couldn't retrieve reliable live data right now. Please try again in a moment.";
    return { text, model, plan: steps, bag };
  }

  stream.note(
    `Synthesizing from ${citations || "tool"} source${citations === 1 ? "" : "s"}…`
  );

  const prompt = buildSynthesisPrompt(
    message,
    route.intent,
    bag,
    wantsRecommendation
  );

  const text = await askOllama(prompt, model, stream.chunk);
  return { text, model, plan: steps, bag };
}

module.exports = {
  planTools,
  runResearchLoop,
  formatWebResults,
  formatNewsResults,
  refineNewsTopic,
  describePlan,
  rewriteSearchQuery,
  rewriteNewsTopic,
  resultsSeemThinOrOffTopic,
  buildSynthesisPrompt,
  MAX_STEPS
};
