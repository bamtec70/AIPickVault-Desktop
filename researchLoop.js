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
    steps.push({
      id: "news",
      tool: "news",
      label: "News",
      args: { topic: payload.topic || "technology" }
    });
    return steps.slice(0, MAX_STEPS);
  }

  if (intent === "search") {
    const query = payload.query || text;
    if (toolsHint.includes("search") || toolsHint.length === 0) {
      steps.push({
        id: "search",
        tool: "search",
        label: "Web search",
        args: { query }
      });
    }
    if (toolsHint.includes("news")) {
      steps.push({
        id: "news",
        tool: "news",
        label: "News",
        args: { topic: query },
        // May refine topic after search results land
        refineFrom: "search"
      });
    }
    // Optional finance when the research query names a known ticker/company
    // and the router did not already classify as stock.
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
        args: { topic: symbol || text }
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
    // One combined news step (counts as 3rd) — topic = both symbols
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
  // Keep it short; prefer original if title is noise
  const cleaned = title
    .replace(/[|\-–—].*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (cleaned.length < 6) return base;
  // Blend: original query stays primary for relevance
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
    return { ok: false, kind: tool, data: tool === "stock" || tool === "weather" ? null : [], error: msg };
  }
}

function mergeStepResult(bag, step, outcome) {
  if (outcome.kind === "web") {
    bag.web = outcome.data || [];
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
  parts.push(`Synthesize one clear answer for the user from the tool results below.`);
  parts.push(`Rules:`);
  parts.push(`- Lead with the answer. Be direct; no filler.`);
  parts.push(`- Use ONLY facts present in the tool results. Never invent prices, headlines, weather numbers, or URLs.`);
  parts.push(`- When citing sources, use the real titles and include their exact links from the lists below.`);
  parts.push(`- If a tool failed or returned nothing, say so briefly and work with what you have.`);
  parts.push(`- No raw JSON. Prefer short structured sections when helpful.`);
  if (wantsRecommendation) {
    parts.push(`- If recommending, use Best Choice / Runner Up / Avoid and label uncertainty.`);
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
 *
 * @param {object} opts
 * @param {string} opts.message
 * @param {{ intent: string, payload?: object }} opts.route
 * @param {string} opts.model
 * @param {{ note: Function, chunk: Function }} opts.stream
 * @param {Function} opts.askOllama - (prompt, model, onChunk, opts?) => Promise<string>
 * @param {{ webSearch: Function, getNews: Function, getStock: Function, getWeather: Function }} opts.tools
 * @param {boolean} [opts.skipSynthesize] - gather tools only (no Ollama synthesis)
 * @returns {Promise<{ text: string, model: string, plan: object[], bag: object }>}
 */
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

  stream.note(`Research plan (${steps.length} step${steps.length === 1 ? "" : "s"}): ${describePlan(steps)}`);

  // Group consecutive steps that share parallelGroup; otherwise run sequential.
  let i = 0;
  let stepOrdinal = 0;
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

      // Feed prior web results into news topic when marked refineFrom
      if (s.refineFrom === "search" && Array.isArray(bag.web) && bag.web.length) {
        const refined = refineNewsTopic(s.args.topic, bag.web);
        if (refined && refined !== s.args.topic) {
          s.args = { ...s.args, topic: refined };
          stream.note(
            `Step ${stepOrdinal}/${steps.length}: ${s.label} (refined topic)…`
          );
        } else {
          stream.note(`Step ${stepOrdinal}/${steps.length}: ${s.label}…`);
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
          `Step ${stepOrdinal}/${steps.length}: ${s.label}${detail}…`
        );
      }

      const outcome = await executeStep(s, toolFns);
      mergeStepResult(bag, s, outcome);

      if (outcome.ok) {
        if (outcome.kind === "web") {
          stream.note(`Found ${outcome.data.length} web result${outcome.data.length === 1 ? "" : "s"}.`);
        } else if (outcome.kind === "news") {
          stream.note(`Found ${outcome.data.length} headline${outcome.data.length === 1 ? "" : "s"}.`);
        } else if (outcome.kind === "stock" && outcome.data && outcome.data.price != null) {
          stream.note(
            `${outcome.symbol}: $${outcome.data.price}` +
              (outcome.data.changePercent != null
                ? ` (${outcome.data.changePercent})`
                : "")
          );
        } else if (outcome.kind === "weather" && outcome.data && outcome.data.location) {
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
    } else {
      // Limited parallel for independent quotes
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
          stream.note(
            `${batch[idx].label} unavailable. Continuing…`
          );
        }
      });
    }

    i += batch.length;
  }

  const citations = countCitations(bag);
  const hasStock = bag.stocks && Object.keys(bag.stocks).some((k) => bag.stocks[k] && !bag.stocks[k].error);
  const hasWeather = bag.weather && !bag.weather.error;
  const hasAny =
    citations > 0 || hasStock || hasWeather;

  if (skipSynthesize) {
    return { text: "", model, plan: steps, bag, gathered: true };
  }

  if (!hasAny) {
    if (wantsRecommendation && typeof askOllama === "function") {
      stream.note("No live sources — drafting a cautious recommendation…");
      const text = await askOllama(
        `Give a practical recommendation for the user. Be direct. Label uncertainty. Do not invent live prices, availability, or URLs.

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
  MAX_STEPS
};
