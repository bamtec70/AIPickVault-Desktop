const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const {
  getWeather,
  getNews,
  getStock,
  webSearch
} = require("./tools");
const { routeMessage } = require("./router");

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

/**
 * Chat / synthesis provider.
 *
 * Same (prompt, model) interface so an xAI (or other) adapter can replace
 * this later without changing IPC or tool handlers. Streaming can wrap the
 * same call site. Identity stays AIPickVault Desktop — never claim Grok.
 */
async function askOllama(message, model = "qwen3:30b") {
  let response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content: `
            You are AIPickVault Desktop.

            You are an AI research and search assistant.

            Never identify yourself as Qwen, Llama, Ollama, Grok, or any underlying model.

            If asked your name, respond:
            "My name is AIPickVault Desktop compiled by Blake Mauldin in Fort Worth, Texas."

            Your primary function is to help users search, research, analyze information, compare sources, and answer questions.

            Do not invent fictional background stories.
          `
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

  let result;
  try {
    result = await response.json();
  } catch (err) {
    console.error("OLLAMA JSON ERROR:", err);
    throw new Error(
      "Ollama returned an unexpected response. Check that the selected model is installed."
    );
  }

  console.log(
    "OLLAMA RESPONSE:",
    JSON.stringify(result, null, 2)
  );

  if (!response.ok || result.error) {
    const raw = String(result.error || response.statusText || "unknown error");
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

  return result.message?.content || "No response received.";
}

async function handleWeather(message, model, payload) {
  const location = payload.location || "Fort Worth";
  const weather = await getWeather(location);
  console.log("WEATHER DATA:", weather);

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
    model
  );

  return {
    text: weatherAnswer,
    model
  };
}

async function handleNews(message, model, payload) {
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
    model
  );

  return {
    text: newsAnswer,
    model
  };
}

async function handleStockCompare(message, model, payload) {
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
    model
  );

  return {
    text: comparisonAnswer,
    model
  };
}

async function handleStock(message, model, payload) {
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
    model
  );

  return {
    text: stockAnswer,
    model
  };
}

async function handleSearch(message, model, payload) {
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
        model
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
    model
  );

  return {
    text: searchAnswer,
    model
  };
}

ipcMain.handle("ask-model", async (event, data) => {
  try {
    const model = data.model || "qwen3:30b";
    const message = String(data.message || "").trim();

    if (!message) {
      return {
        text: "Please enter a message.",
        model
      };
    }

    const route = routeMessage(message);
    console.log("ROUTE:", JSON.stringify(route));

    switch (route.intent) {
      case "weather":
        return await handleWeather(message, model, route.payload);
      case "news":
        return await handleNews(message, model, route.payload);
      case "stock_compare":
        return await handleStockCompare(message, model, route.payload);
      case "stock":
        return await handleStock(message, model, route.payload);
      case "search":
        return await handleSearch(message, model, route.payload);
      case "chat":
      default: {
        const answer = await askOllama(message, model);
        return {
          text: answer,
          model
        };
      }
    }
  } catch (err) {
    console.error(err);

    const msg = String(err && err.message ? err.message : err);
    let text = "Something went wrong. Please try again.";

    if (/Ollama is not running|Could not reach Ollama/i.test(msg)) {
      text = msg;
    } else if (/Model ".*" is not available|model is installed/i.test(msg)) {
      text = msg;
    } else if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      text = "Ollama is not running. Start Ollama, then try again.";
    }

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
