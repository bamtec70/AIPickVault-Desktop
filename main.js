const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const {
  getWeather,
  getNews,
  getStock,
  webSearch,
  fetchWebpage
} = require("./tools");
const { routeMessage, needsFactualRefresh } = require("./router");
const { runResearchLoop, planTools, formatNewsResults } = require("./researchLoop");
const sessionLog = require("./sessionLog");
const { createDurableMemory } = require("./durableMemory");
const { shouldUseKnowledgeFirst, domainPackPromptSection, ensureGigVehicleDomainRoute } = require("./domain/gigVehicle");

/** Durable facts across sessions (userData/memory.json). */
let durableMemory = null;

function getDurableMemory() {
  if (!durableMemory) {
    durableMemory = createDurableMemory(() => {
      try {
        return app.getPath("userData");
      } catch (_) {
        return path.join(__dirname, ".memory");
      }
    });
  }
  return durableMemory;
}


const SYSTEM_PROMPT = `You are AIPickVault Desktop — a general local research assistant by Blake Mauldin in Fort Worth, Texas.

Identity
- If asked who you are or your name: say you are AIPickVault Desktop, compiled by Blake Mauldin in Fort Worth, Texas.
- Never claim to be Grok, ChatGPT, Claude, or any other product.
- Never say you are Qwen, Llama, Ollama, or name the underlying engine unless the user explicitly asks how you run.

What you can do
- Weather, news, stocks/finance, web search, webpage fetch/review, general conversation, and local research.
- A gig/delivery vehicle specialist domain pack exists for Blake's courier / TCO / used-car questions — use it ONLY when that subject is active. Never claim you are limited to vehicle recommendations, cost/maintenance analysis, or research-only vehicle advice.
- Never say you cannot view or analyze websites when page content was fetched, or when the user asks you to look at a URL/page (the app can fetch it). If a fetch failed, say so clearly and still give useful high-level feedback from what you have.

Reasoning (Grok-like, as far as local models allow)
- Think through tradeoffs before answering. Challenge weak or irrelevant sources.
- Prefer a coherent, decisive answer over tool-meta, apologies, or "I couldn't find…".
- Be honest about uncertainty.

When (and only when) advising on vehicles / gig delivery
- Blake does last-mile gig delivery (DoorDash, Uber, Uber Eats, Roadie, Amazon Flex, Shipt), maintains a cargo van, and is also evaluating a sub-$10k car for food/gig delivery — Fort Worth / Alliance (76177). Use durable memory facts when present.
- Rank by overall annual cost, reliability, and maintenance for HIS use — not badge prestige.

Anti-hallucination (critical)
- Never invent specific for-sale cars, VINs, dealer inventory, sticker/asking prices, or "verified at dealer" claims.
- Never invent listing URLs (Autotrader, Cars.com, CarGurus, etc.). Only cite URLs/titles that appear in tool results; otherwise tell him to check Autotrader/Cars.com filters for Fort Worth / Alliance.
- Label estimates clearly vs sourced facts. In research answers, a short "Sourced vs estimate" line is welcome.
- Do not invent NHTSA recall campaign IDs unless present in tool text; if unsure, search first (do not guess).
- Do not double-count cost buckets (e.g. tires listed twice under maintenance and tires).
- Never invent fake AAA/insurance statistics or live prices not present in tool results.
- Never invent SOH percentages, failure probabilities, "X% of cars have…", reliability index scores (e.g. 3.2/5.0), or NHTSA campaign details unless those exact figures appear in tool result text.
- Prefer qualitative heuristics for battery/reliability (e.g. "battery health varies; require PPI / SOH report") over fabricated precise stats.
- Never invent hard SOH cutoffs (e.g. "SOH < 80% reject"), insurance percentages (e.g. "10–15%"), "guaranteed" claims, or exact gallon/$ fuel-penalty arithmetic unless those figures appear in tool results.
- Illustrative ranges OK only if clearly labeled estimate; prefer qualitative when unsure.
- Prefer Alliance / Fort Worth 76177; never invent ZIP bands (e.g. 76102–76140).
- On pack-only / domain-pack turns, "Sourced vs estimate" must say pack heuristic only — do not over-claim NHTSA or market sourcing.
- Never label mainstream US-market cars as "foreign imports to avoid."
- For webpage reviews: do not invent page quotes that are not in the fetched extract.
- LOCKED gig Corolla years/trim: **2010–2015 LE/SE** (not XLE-only, not 2014–2015-only). Do not invent "2010–2013 too risky" without tool evidence.
- ~40k mi/yr is Blake's **annual use** — NOT a hard under-40k listing odometer cap. Prefer lower miles; higher OK if price/condition/PPI justify.
- Never invent example asking prices (e.g. "$8,995"), claim "I've tested this", "100% of listings", or "100% safe".
- Year-recall → answer 2010–2015 LE/SE from the domain pack. Locate recommended Corolla/Prius → restate pack pick + listing filters near 76177; never pretend no recommendation exists.
- Never brand yourself "Fort Worth Local Advisor". No gig-vehicle asides on stocks/weather/news unless asked.
- On public webpage HTTP 403/blocked fetches: short human message + fallback (web search or paste listings) — never dump .env / API-key advice for public web 403.

Style
- Be direct and specific. No filler, no throat-clearing, no "Great question!" or "I'd be happy to help".
- Lead with the answer. Keep prose tight.
- Admit uncertainty with precision; do not hide behind tool failures.
- When tool results or source lists are provided, use the useful ones and cite titles with links. Discard app-store / wrong-country spam mentally.
- Prefer structured answers for stocks, weather, webpage reviews, and research (clear headings/sections).
- For follow-ups, use prior conversation context and durable memory; resolve pronouns when obvious.`;

/** Max user+assistant messages retained (oldest dropped first). */
const MAX_HISTORY_MESSAGES = 16;
/** Rough char budget for history (≈ tokens×4); drop oldest when exceeded. */
const MAX_HISTORY_CHARS = 24000;

/** @type {{ role: 'user'|'assistant', content: string }[]} */
let conversationHistory = [];

function clearConversationMemory() {
  conversationHistory = [];
  console.log("Conversation memory cleared");
}

function historyCharCount() {
  return conversationHistory.reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
}

function trimConversationHistory() {
  while (conversationHistory.length > MAX_HISTORY_MESSAGES) {
    conversationHistory.shift();
  }
  while (conversationHistory.length > 2 && historyCharCount() > MAX_HISTORY_CHARS) {
    conversationHistory.shift();
  }
  // Keep pairs aligned: if we start on assistant, drop it
  if (conversationHistory.length && conversationHistory[0].role === "assistant") {
    conversationHistory.shift();
  }
}

function rememberTurn(userText, assistantText) {
  conversationHistory.push({ role: "user", content: String(userText || "") });
  conversationHistory.push({
    role: "assistant",
    content: String(assistantText || "")
  });
  trimConversationHistory();
}

function memoryTurnCount() {
  return Math.floor(conversationHistory.length / 2);
}

function withResultMeta(result) {
  return {
    ...result,
    memoryTurns: memoryTurnCount()
  };
}


/**
 * Short follow-ups with pronouns — prefer chat+history over a wrong re-route.
 * Strong new targets (explicit ticker, compare, search command, new city) still win.
 */
function looksLikeFollowUp(message) {
  const lower = String(message || "").toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 14) return false;
  return /\b(that|this|it|they|those|them|the same|same (?:one|stock|thing|place)|what about (?:it|that|them|the)|how about (?:it|that)|and (?:the|for|tomorrow|today|there)|more (?:detail|details|info|on|about)|tell me more|the forecast|that stock|that one|same for)\b/i.test(
    lower
  );
}

function hasStrongNewToolTarget(message, route) {
  const text = String(message || "");
  const lower = text.toLowerCase();

  if (route.intent === "stock_compare") return true;

  if (route.intent === "stock" && route.payload && route.payload.symbol) {
    const sym = String(route.payload.symbol);
    if (new RegExp(`\\b${sym}\\b`, "i").test(text)) return true;
    if (/\$[A-Za-z]{1,5}\b/.test(text)) return true;
  }

  if (route.intent === "weather") {
    if (/\bin\s+[A-Za-z]{2,}/.test(text)) return true;
    // Explicit new weather ask without pronoun-only follow-up
    if (
      /\b(weather|forecast|temperature)\b/i.test(lower) &&
      !looksLikeFollowUp(text)
    ) {
      return true;
    }
  }

  if (needsFactualRefresh(text)) return true;

  if (route.intent === "search" && /^(search|look\s*up|lookup|find|google)\b/i.test(text)) {
    return true;
  }

  if (
    route.intent === "news" &&
    /\b(news|headlines|breaking)\b/i.test(lower) &&
    !/\b(that|those|the same|it)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Mid-conversation factual asks (recall, NHTSA, price, listing, insurance,
 * availability, or challenging a prior pick) must re-run search — never pure chat.
 */
function forceToolRefreshRoute(message, route) {
  if (!needsFactualRefresh(message)) return route;
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const tools = ["search"];
  if (/\b(recall|nhtsa|latest|today|breaking|news)\b/i.test(lower)) {
    tools.push("news");
  }

  if (route && route.intent && route.intent !== "chat") {
    const prev = (route.payload && Array.isArray(route.payload.tools) && route.payload.tools.length)
      ? route.payload.tools.slice()
      : [];
    const merged = Array.from(new Set(prev.concat(tools)));
    console.log("FORCE_TOOL_REFRESH → keep", route.intent, "tools:", merged.join(","));
    return {
      ...route,
      payload: {
        ...(route.payload || {}),
        tools: merged,
        forceToolRefresh: true,
        query: (route.payload && route.payload.query) || text
      }
    };
  }

  console.log("FORCE_TOOL_REFRESH → search tools:", tools.join(","));
  return {
    intent: "search",
    payload: {
      query: text,
      tools,
      forceToolRefresh: true,
      wantsRecommendation: !!(route && route.payload && route.payload.wantsRecommendation)
    }
  };
}

function maybePreferChatHistory(message, route) {
  if (conversationHistory.length === 0) return route;
  // Factual refresh follow-ups must re-run tools, never demote to pure chat.
  if (needsFactualRefresh(message)) {
    return forceToolRefreshRoute(message, route);
  }
  if (!looksLikeFollowUp(message)) return route;
  if (hasStrongNewToolTarget(message, route)) return route;
  console.log(
    "FOLLOW-UP → chat with history (was:",
    route.intent,
    ")"
  );
  return {
    intent: "chat",
    payload: { tools: [], followUp: true }
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");
}

function friendlyOllamaError(err, model) {
  const msg = String(err && err.message ? err.message : err);
  if (/Ollama is not running|Could not reach Ollama/i.test(msg)) {
    return msg;
  }
  if (/Model ".*" is not available|model is installed/i.test(msg)) {
    return msg;
  }
  if (/ECONNREFUSED|fetch failed|network|ENOTFOUND|ECONNRESET/i.test(msg)) {
    return "Ollama is not running. Start Ollama, then try again.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * Core Ollama chat with a full messages[] array (streaming).
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} [model]
 * @param {(delta: string) => void} [onChunk]
 * @returns {Promise<string>}
 */
async function askOllamaMessages(messages, model = "qwen3:30b", onChunk, opts) {
  const payloadMessages = Array.isArray(messages) ? messages : [];
  const think = !!(opts && opts.think);
  console.log(
    "OLLAMA_MESSAGES:",
    payloadMessages.length,
    "(history turns:",
    memoryTurnCount(),
    ")",
    think ? "[think]" : ""
  );

  let response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: payloadMessages,
        ...(think ? { think: true } : {})
      })
    });
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    console.error("OLLAMA FETCH ERROR:", detail);
    if (/ECONNREFUSED|fetch failed|network|ENOTFOUND|ECONNRESET/i.test(detail)) {
      throw new Error(
        "Ollama is not running. Start Ollama, then try again."
      );
    }
    throw new Error(
      "Could not reach Ollama. Make sure it is running on this PC."
    );
  }

  if (!response.ok) {
    let raw = response.statusText || "unknown error";
    try {
      const errBody = await response.text();
      const parsed = JSON.parse(errBody);
      if (parsed && parsed.error) raw = String(parsed.error);
      else if (errBody) raw = errBody.slice(0, 200);
    } catch (_) {
      /* keep statusText */
    }
    console.error("OLLAMA API ERROR:", raw);
    if (/not found|pull|unknown model|does not exist/i.test(raw)) {
      throw new Error(
        `Model "${model}" is not available in Ollama. Pull it with: ollama pull ${model}`
      );
    }
    throw new Error(
      "Ollama could not complete the request. Check that Ollama is running and the model is installed."
    );
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return parseOllamaNdjson(text, model, onChunk);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let sawError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        console.error("OLLAMA NDJSON PARSE ERROR:", trimmed.slice(0, 120));
        continue;
      }

      if (obj.error) {
        sawError = String(obj.error);
        break;
      }

      // Thinking stays off the UI; only final content streams to the user
      if (obj.message && typeof obj.message.thinking === "string" && obj.message.thinking) {
        /* accumulate silently for quality; do not onChunk */
      }
      const delta = obj.message && obj.message.content;
      if (typeof delta === "string" && delta.length > 0) {
        full += delta;
        if (typeof onChunk === "function") {
          onChunk(delta);
        }
      }
    }

    if (sawError) break;
  }

  if (!sawError && buffer.trim()) {
    try {
      const obj = JSON.parse(buffer.trim());
      if (obj.error) {
        sawError = String(obj.error);
      } else {
        const delta = obj.message && obj.message.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          if (typeof onChunk === "function") onChunk(delta);
        }
      }
    } catch (_) {
      /* ignore trailing junk */
    }
  }

  if (sawError) {
    console.error("OLLAMA STREAM ERROR:", sawError);
    if (/not found|pull|unknown model|does not exist/i.test(sawError)) {
      throw new Error(
        `Model "${model}" is not available in Ollama. Pull it with: ollama pull ${model}`
      );
    }
    throw new Error(
      "Ollama could not complete the request. Check that Ollama is running and the model is installed."
    );
  }

  return full || "No response received.";
}

/**
 * Single-prompt helper (wrapper). Builds system + optional history + user.
 * @param {string} prompt
 * @param {string} [model]
 * @param {(delta: string) => void} [onChunk]
 * @param {{ includeHistory?: boolean }} [opts]
 */
async function askOllama(prompt, model = "qwen3:30b", onChunk, opts) {
  const includeHistory = !opts || opts.includeHistory !== false;
  const think = !!(opts && opts.think);
  const memSuffix = getDurableMemory().buildSystemSuffix();
  let system = SYSTEM_PROMPT + memSuffix;
  // Knowledge-first: inject gig-vehicle pack ONLY for vehicle/gig subject turns —
  // never for weather/fetch/general chat. Prefer explicit userMessage over synth prompt.
  const subjectText = String((opts && opts.userMessage) || prompt || "");
  const looksLikeSynthPrompt =
    /Intent:\s*(weather|fetch|news|stock)/i.test(subjectText) ||
    /^You are AIPickVault Desktop — a general local research assistant\./.test(subjectText);
  if (
    !looksLikeSynthPrompt &&
    shouldUseKnowledgeFirst(subjectText, (opts && opts.route) || null, {
      conversationHistory,
      durableMemory: getDurableMemory()
    })
  ) {
    system += domainPackPromptSection();
  }
  const messages = [{ role: "system", content: system }];
  if (includeHistory && conversationHistory.length) {
    for (const m of conversationHistory) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: String(prompt || "") });
  return askOllamaMessages(messages, model, onChunk, { think });
}

/** Parse a complete NDJSON body (used when stream reader unavailable). */
function parseOllamaNdjson(text, model, onChunk) {
  let full = "";
  const lines = String(text || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    if (obj.error) {
      const raw = String(obj.error);
      if (/not found|pull|unknown model|does not exist/i.test(raw)) {
        throw new Error(
          `Model "${model}" is not available in Ollama. Pull it with: ollama pull ${model}`
        );
      }
      throw new Error(
        "Ollama could not complete the request. Check that Ollama is running and the model is installed."
      );
    }
    const delta = obj.message && obj.message.content;
    if (typeof delta === "string" && delta.length > 0) {
      full += delta;
      if (typeof onChunk === "function") onChunk(delta);
    }
  }
  return full || "No response received.";
}

function makeStream(event) {
  const sender = event.sender;
  return {
    note(text) {
      const t = String(text || "");
      if (/synthesiz/i.test(t)) {
        sessionLog.synthesize(t);
      } else if (/^Step\s/i.test(t) || /unavailable|Found |parallel|Research plan/i.test(t)) {
        const fail = /unavailable/i.test(t);
        sessionLog.toolStep(t, !fail, "");
      } else {
        sessionLog.info("NOTE", t);
      }
      if (sender && !sender.isDestroyed()) {
        sender.send("ask-model-note", { text: t });
      }
    },
    chunk(delta) {
      if (sender && !sender.isDestroyed()) {
        sender.send("ask-model-chunk", { chunk: String(delta || "") });
      }
    },
    done(payload) {
      if (sender && !sender.isDestroyed()) {
        sender.send("ask-model-done", payload);
      }
    },
    error(text) {
      if (sender && !sender.isDestroyed()) {
        sender.send("ask-model-error", { text: String(text || "") });
      }
    }
  };
}

function toolFns() {
  return { getWeather, getNews, getStock, webSearch, fetchWebpage };
}

async function runRoutedResearch(message, model, route, stream) {
  const useThink = /^qwen3/i.test(String(model || ""));
  const loopResult = await runResearchLoop({
    message,
    route,
    model,
    stream,
    askOllama,
    tools: toolFns(),
    think: useThink
  });

  const text = loopResult.text || "No response received.";
  rememberTurn(message, text);
  return withResultMeta({
    text,
    model: loopResult.model || model,
    plan: (loopResult.plan || []).map((s) => s.tool)
  });
}

async function handleWeather(message, model, payload, stream) {
  return runRoutedResearch(
    message,
    model,
    { intent: "weather", payload: payload || {} },
    stream
  );
}

async function handleNews(message, model, payload, stream) {
  return runRoutedResearch(
    message,
    model,
    { intent: "news", payload: payload || {} },
    stream
  );
}

async function handleStockCompare(message, model, payload, stream) {
  const symbols = (payload && payload.symbols) || [];
  if (!symbols[0] || !symbols[1]) {
    const text =
      "Specify two stock symbols to compare, e.g. compare AAPL vs MSFT.";
    rememberTurn(message, text);
    return withResultMeta({
      text,
      model: "Stock Tool"
    });
  }

  const gatherRoute = {
    intent: "stock_compare",
    payload: { symbols, tools: ["stock", "news"] }
  };
  const planned = planTools(gatherRoute, message);

  // Gather via multi-step loop (parallel quotes + news) without synthesizing yet.
  const loopResult = await runResearchLoop({
    message,
    route: gatherRoute,
    model,
    stream,
    askOllama,
    tools: toolFns(),
    skipSynthesize: true
  });

  const bag = loopResult.bag || {};
  const [symbol1, symbol2] = symbols;
  const stock1 = (bag.stocks && bag.stocks[symbol1]) || { error: "No data" };
  const stock2 = (bag.stocks && bag.stocks[symbol2]) || { error: "No data" };
  const newsList = Array.isArray(bag.news) ? bag.news : [];

  stream.note("Comparing " + symbol1 + " vs " + symbol2 + " — synthesizing…");

  const comparisonAnswer = await askOllama(
    `Compare these two stocks using ONLY the data below. Use actual prices from the data; do not invent. Structure:

STOCK COMPARISON
Winner:
Current Price Comparison
Risk Comparison
Outlook Comparison
Strengths of ${symbol1}
Strengths of ${symbol2}
Which Stock Looks Better Right Now?

Cite news by title and include real links when relevant. Never invent URLs. No JSON dump.

User question:
${message}

${symbol1} stock:
${JSON.stringify(stock1, null, 2)}

${symbol2} stock:
${JSON.stringify(stock2, null, 2)}

Related news:
${formatNewsResults(newsList)}`,
    model,
    stream.chunk
  );

  rememberTurn(message, comparisonAnswer);
  return withResultMeta({
    text: comparisonAnswer,
    model,
    plan: planned.map((s) => s.tool)
  });
}

async function handleStock(message, model, payload, stream) {
  return runRoutedResearch(
    message,
    model,
    { intent: "stock", payload: payload || {} },
    stream
  );
}

async function handleSearch(message, model, payload, stream) {
  return runRoutedResearch(
    message,
    model,
    { intent: "search", payload: payload || {} },
    stream
  );
}

async function handleFetch(message, model, payload, stream) {
  return runRoutedResearch(
    message,
    model,
    { intent: "fetch", payload: payload || {} },
    stream
  );
}

async function handleChat(message, model, stream) {
  const answer = await askOllama(message, model, stream.chunk, {
    includeHistory: true
  });
  rememberTurn(message, answer);
  return withResultMeta({
    text: answer,
    model
  });
}

ipcMain.handle("clear-conversation", async () => {
  clearConversationMemory();
  return { ok: true, memoryTurns: 0 };
});

ipcMain.handle("ask-model", async (event, data) => {
  const stream = makeStream(event);
  const model = (data && data.model) || "qwen3:30b";

  try {
    const message = String((data && data.message) || "").trim();

    if (!message) {
      const result = withResultMeta({
        text: "Please enter a message.",
        model
      });
      stream.done(result);
      return result;
    }

    sessionLog.prompt(message);

    try {
      const learned = getDurableMemory().learnFromUserMessage(message);
      if (learned && learned.learned && learned.learned.length) {
        sessionLog.info("MEMORY_LEARN", learned.learned.join(", "));
      }
    } catch (memErr) {
      console.error("durable memory learn error:", memErr);
    }

    let route = routeMessage(message);
    route = maybePreferChatHistory(message, route);
    route = forceToolRefreshRoute(message, route);
    // Hard same-subject gig-vehicle follow-ups (Prius/Corolla/TCO/van) → domain pack, not plain chat.
    {
      const before = route;
      route = ensureGigVehicleDomainRoute(message, route, {
        conversationHistory,
        durableMemory: getDurableMemory()
      });
      if (route !== before && route.intent === "search" && route.payload && route.payload.domainPackPreferred) {
        console.log("GIG_VEHICLE_DOMAIN → search/domain (was:", before.intent, ")");
        sessionLog.info("GIG_VEHICLE_DOMAIN", "upgraded from " + before.intent + " for knowledge-first pack");
      }
    }
    console.log("ROUTE:", JSON.stringify(route));
    sessionLog.route(route);
    console.log(
      "MEMORY_BEFORE:",
      conversationHistory.length,
      "msgs /",
      memoryTurnCount(),
      "turns"
    );
    sessionLog.info(
      "MEMORY_BEFORE",
      conversationHistory.length + " msgs / " + memoryTurnCount() + " turns"
    );

    let result;
    switch (route.intent) {
      case "weather":
        result = await handleWeather(message, model, route.payload, stream);
        break;
      case "news":
        result = await handleNews(message, model, route.payload, stream);
        break;
      case "stock_compare":
        result = await handleStockCompare(
          message,
          model,
          route.payload,
          stream
        );
        break;
      case "stock":
        result = await handleStock(message, model, route.payload, stream);
        break;
      case "search":
        result = await handleSearch(message, model, route.payload, stream);
        break;
      case "fetch":
        result = await handleFetch(message, model, route.payload, stream);
        break;
      case "chat":
      default:
        result = await handleChat(message, model, stream);
        break;
    }

    console.log(
      "MEMORY_AFTER:",
      conversationHistory.length,
      "msgs /",
      memoryTurnCount(),
      "turns"
    );
    sessionLog.info(
      "MEMORY_AFTER",
      conversationHistory.length + " msgs / " + memoryTurnCount() + " turns"
    );
    if (result && result.text) {
      sessionLog.reply(result.text);
    }
    if (result && result.plan) {
      sessionLog.info("PLAN", JSON.stringify(result.plan));
    }

    stream.done(result);
    return result;
  } catch (err) {
    console.error(err);
    sessionLog.error("ASK_MODEL", err);
    const text = friendlyOllamaError(err, model);
    stream.error(text);
    return withResultMeta({
      text,
      model: "Error"
    });
  }
});

app.whenReady().then(() => {
  durableMemory = createDurableMemory(() => app.getPath("userData"));
  try {
    if (typeof durableMemory.ensureSeedProfile === "function") {
      const seeded = durableMemory.ensureSeedProfile();
      if (seeded && seeded.added && seeded.added.length) {
        sessionLog.info("MEMORY_SEED", seeded.added.join(", "));
      }
    }
  } catch (seedErr) {
    console.error("durable memory seed error:", seedErr);
  }
  console.log("Durable memory ->", durableMemory.memoryPath());
  sessionLog.info("DURABLE_MEMORY", durableMemory.memoryPath());
  const logPath = sessionLog.getLogPath();
  sessionLog.info("APP_START", "session log -> " + logPath);
  console.log("AIPickVault Desktop session log:", logPath);
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
