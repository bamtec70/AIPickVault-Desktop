const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const {
  getWeather,
  getNews,
  getStock,
  webSearch
} = require("./tools");
const { routeMessage } = require("./router");

const SYSTEM_PROMPT = `
            You are AIPickVault Desktop.

            You are an AI research and search assistant.

            Never identify yourself as Qwen, Llama, Ollama, Grok, or any underlying model.

            If asked your name, respond:
            "My name is AIPickVault Desktop compiled by Blake Mauldin in Fort Worth, Texas."

            Your primary function is to help users search, research, analyze information, compare sources, and answer questions.

            Do not invent fictional background stories.
          `;

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
 * Chat / synthesis provider with optional token streaming.
 *
 * Same (prompt, model) interface so an xAI (or other) adapter can replace
 * this later without changing IPC or tool handlers. Identity stays
 * AIPickVault Desktop — never claim Grok.
 *
 * @param {string} message
 * @param {string} [model]
 * @param {(delta: string) => void} [onChunk] called with each content delta
 * @returns {Promise<string>} full assembled reply
 */
async function askOllama(message, model = "qwen3:30b", onChunk) {
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
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT
          },
          {
            role: "user",
            content: message
          }
        ]
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
    // Fallback if body is not a web ReadableStream
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

  // Flush trailing buffer (final line without newline)
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
      if (sender && !sender.isDestroyed()) {
        sender.send("ask-model-note", { text: String(text || "") });
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

async function handleWeather(message, model, payload, stream) {
  const location = payload.location || "Fort Worth";
  const weather = await getWeather(location);
  console.log("WEATHER DATA:", weather);

  if (weather && !weather.error) {
    const bits = [];
    if (weather.location) bits.push(weather.location);
    if (weather.current) {
      bits.push(
        `${weather.current.temp_f}°F, ${weather.current.condition || ""}`.trim()
      );
    }
    stream.note(`Weather data loaded${bits.length ? ": " + bits.join(" — ") : ""}.`);
  }

  const weatherAnswer = await askOllama(
    `You are a helpful weather assistant.

      User Question:
      ${message}

      Weather Data:
      ${JSON.stringify(weather, null, 2)}

      Answer the user's weather question using the weather data provided.

      If the question is about tomorrow,
      use the tomorrow forecast.

      If the question is about today,
      use today's weather.

      Do not show JSON.

      Be concise and friendly.
      `,
    model,
    stream.chunk
  );

  return {
    text: weatherAnswer,
    model
  };
}

async function handleNews(message, model, payload, stream) {
  const topic = payload.topic || "technology";
  const news = await getNews(topic);

  if (!Array.isArray(news) || news.length === 0) {
    return {
      text: `No ${topic} news was found.`,
      model: "News Tool"
    };
  }

  let formatted = `📰 ${topic.toUpperCase()} NEWS\n\n`;

  news.forEach((article, index) => {
    formatted += `━━━━━━━━━━━━━━━━━━\n`;
    formatted += `${index + 1}. ${article.title}\n\n`;
    formatted += `Source: ${article.source}\n`;
    formatted += `Link: ${article.url}\n\n`;
  });

  stream.note(
    `Found ${news.length} ${topic} headlines. Summarizing…`
  );

  const newsAnswer = await askOllama(
    `You are a news analyst.

  User Request:
  ${message}

  News Results:

  ${formatted}

  Summarize the most important stories.

  Explain why they matter.

  Do not simply list headlines.

  Provide a concise and natural response.
  `,
    model,
    stream.chunk
  );

  return {
    text: newsAnswer,
    model
  };
}

async function handleStockCompare(message, model, payload, stream) {
  const [symbol1, symbol2] = payload.symbols || [];
  if (!symbol1 || !symbol2) {
    return {
      text: "Specify two stock symbols to compare, e.g. compare AAPL vs MSFT.",
      model: "Stock Tool"
    };
  }

  console.log("COMPARING:", symbol1, "VS", symbol2);

  const stock1 = await getStock(symbol1);
  const stock2 = await getStock(symbol2);
  const news1 = await getNews(symbol1);
  const news2 = await getNews(symbol2);

  stream.note(`Comparing ${symbol1} vs ${symbol2} — analyzing…`);

  const comparisonAnswer = await askOllama(
    `
You are an elite stock analyst.

Compare these two stocks.

${symbol1}

Stock Data:
${JSON.stringify(stock1, null, 2)}

News:
${JSON.stringify(news1, null, 2)}

${symbol2}

Stock Data:
${JSON.stringify(stock2, null, 2)}

News:
${JSON.stringify(news2, null, 2)}

Generate:

STOCK COMPARISON

Winner:
(stock symbol)

Current Price Comparison

Risk Comparison

Outlook Comparison

Strengths of ${symbol1}

Strengths of ${symbol2}

Which Stock Looks Better Right Now?

Provide a concise professional report.

Do not output JSON.
`,
    model,
    stream.chunk
  );

  return {
    text: comparisonAnswer,
    model
  };
}

async function handleStock(message, model, payload, stream) {
  const symbol = payload.symbol;
  if (!symbol) {
    return {
      text: "Specify a stock symbol or company name.",
      model: "Stock Tool"
    };
  }

  console.log("REQUESTING STOCK:", symbol);

  const stock = await getStock(symbol);
  console.log("REQUESTING NEWS:", symbol);

  let stockNews = [];
  try {
    stockNews = await getNews(symbol);
  } catch (err) {
    console.log("NEWS ERROR:", err.message);
  }

  console.log("STOCK NEWS:", JSON.stringify(stockNews, null, 2));

  if (stock && !stock.error && stock.price != null) {
    stream.note(
      `${symbol}: $${stock.price}` +
        (stock.changePercent != null ? ` (${stock.changePercent})` : "") +
        " — building report…"
    );
  } else {
    stream.note(`Looking up ${symbol}…`);
  }

  const stockAnswer = await askOllama(
    `You are an elite stock research analyst.

      User Question:
      ${message}

      Stock Data:
      ${JSON.stringify(stock, null, 2)}

      Related News:
      ${JSON.stringify(stockNews, null, 2)}

      Generate a report using this structure:

      ${symbol} STOCK REPORT

      Current Price:
      Use the actual value from Stock Data.

      Daily Change:
      Use the actual value from Stock Data.

      Open:
      Use the actual value from Stock Data.

      Day High:
      Use the actual value from Stock Data.

      Day Low:
      Use the actual value from Stock Data.

      Previous Close:
      Use the actual value from Stock Data.

      Trend:
      Bullish, Bearish, or Neutral

      Risk Score:
      Provide a score from 1-10.

      Confidence:
      Choose Low, Medium, or High.

      Outlook:
      Choose Bullish, Neutral, or Bearish.

      Positive Catalysts:
      • item
      • item
      • item

      Risks:
      • item
      • item
      • item

      News Impact:
      (short explanation)

      Investor Sentiment:
      Positive, Neutral, or Negative

      Bottom Line:
      (short conclusion)

      Base your analysis on both the stock data and the news.
      Risk Score Guidance:

      1-3 = Low Risk
      4-6 = Moderate Risk
      7-8 = High Risk
      9-10 = Very High Risk

      Confidence Guidance:

      Low = Limited evidence
      Medium = Mixed evidence
      High = Strong supporting evidence

      Outlook:

      Bullish = More positive than negative
      Neutral = Mixed outlook
      Bearish = More negative than positive

      Do not output JSON.
      `,
    model,
    stream.chunk
  );

  return {
    text: stockAnswer,
    model
  };
}

async function handleSearch(message, model, payload, stream) {
  const query = payload.query || message;
  const tools = payload.tools || ["search"];
  const wantsRecommendation = !!payload.wantsRecommendation;

  console.log("SEARCH QUERY:", query);
  console.log("SEARCH TOOLS:", tools);

  const useNews = tools.includes("news");

  console.log("STARTING WEB SEARCH...");
  const results = await webSearch(query);
  console.log("WEB SEARCH FINISHED");

  let newsResults = [];
  if (useNews) {
    console.log("STARTING NEWS SEARCH...");
    newsResults = await getNews(query);
    console.log("NEWS SEARCH FINISHED");
  }

  const hasWebResults =
    Array.isArray(results) && results.length > 0 && !results.error;
  const hasNewsResults =
    Array.isArray(newsResults) && newsResults.length > 0 && !newsResults.error;

  if (!hasWebResults && !hasNewsResults) {
    if (wantsRecommendation) {
      stream.note("No live results — drafting a recommendation…");
      const recommendationAnswer = await askOllama(
        `You are an expert recommendation engine.

     User Question:
     ${message}

     Provide:

     Best Choice:
     Why it is best.

     Runner Up:
     Why it is good.

     Third Choice:
     Why it is good.

     Avoid:
     What should be avoided and why.

     Use practical real-world reasoning.

     Answer naturally.
     `,
        model,
        stream.chunk
      );

      return {
        text: recommendationAnswer,
        model
      };
    }

    return {
      text: "I couldn't retrieve reliable search results right now. Please try again in a moment.",
      model
    };
  }

  const nWeb = hasWebResults ? results.length : 0;
  const nNews = hasNewsResults ? newsResults.length : 0;
  stream.note(
    `Sources ready (${nWeb} web` +
      (useNews ? `, ${nNews} news` : "") +
      "). Analyzing…"
  );

  const searchAnswer = await askOllama(
    `You are an investigative research analyst.

     User Question:
     ${message}

     Web Search Results:
     ${JSON.stringify(hasWebResults ? results : [], null, 2)}

     News Results:
     ${JSON.stringify(hasNewsResults ? newsResults : [], null, 2)}

     Instructions:

     - Use both Web Search Results and News Results when present.
     - Prefer the most recent credible information available.
     - Prefer official sources when available.
     - Distinguish facts from opinions.
     - Mention uncertainty only when it materially affects the answer.
     - Do not expose your analysis process.

     When answering:

     1. Lead with the answer immediately.
     2. Explain why it matters.
     3. Explain the key drivers behind the situation.
     4. Connect the facts together into a single narrative.
     5. Avoid bullet lists unless they improve clarity.
     6. Avoid phrases like:
        - "Key points include"
        - "According to reports"
        - "Several sources suggest"
     7. Sound like a knowledgeable analyst speaking directly to the user.
     8. Do not repeat information unnecessarily.
     9. Do not expose your research process.
     10. Be concise but insightful.

     Answer naturally.
     `,
    model,
    stream.chunk
  );

  return {
    text: searchAnswer,
    model
  };
}

ipcMain.handle("ask-model", async (event, data) => {
  const stream = makeStream(event);
  const model = (data && data.model) || "qwen3:30b";

  try {
    const message = String((data && data.message) || "").trim();

    if (!message) {
      const result = {
        text: "Please enter a message.",
        model
      };
      stream.done(result);
      return result;
    }

    const route = routeMessage(message);
    console.log("ROUTE:", JSON.stringify(route));

    let result;
    switch (route.intent) {
      case "weather":
        result = await handleWeather(message, model, route.payload, stream);
        break;
      case "news":
        result = await handleNews(message, model, route.payload, stream);
        break;
      case "stock_compare":
        result = await handleStockCompare(message, model, route.payload, stream);
        break;
      case "stock":
        result = await handleStock(message, model, route.payload, stream);
        break;
      case "search":
        result = await handleSearch(message, model, route.payload, stream);
        break;
      case "chat":
      default: {
        const answer = await askOllama(message, model, stream.chunk);
        result = {
          text: answer,
          model
        };
        break;
      }
    }

    stream.done(result);
    return result;
  } catch (err) {
    console.error(err);
    const text = friendlyOllamaError(err, model);
    stream.error(text);
    return {
      text,
      model: "Error"
    };
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
