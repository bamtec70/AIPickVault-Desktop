const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const {
  getWeather,
  getNews,
  getStock,
  webSearch
} = require("./tools");

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

async function askOllama(message, model = "llama3") {
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
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

            Never identify yourself as Qwen, Llama, Ollama, or any underlying model.

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

  const result = await response.json();

  console.log(
    "OLLAMA RESPONSE:",
    JSON.stringify(result, null, 2)
  );

  return result.message?.content || "No response received.";
}


ipcMain.handle("ask-model", async (event, data) => {
  try {
    const model = data.model || "llama3";
    const message = data.message.trim();
    const lower = message.toLowerCase();
    const recommendationIntent =
      lower.includes("best") ||
      lower.includes("recommend") ||
      lower.includes("should i buy") ||
      lower.includes("what vehicle") ||
      lower.includes("what car") ||
      lower.includes("what truck") ||
      lower.includes("what suv") ||
      lower.includes("what hybrid") ||
      lower.includes("which vehicle") ||
      lower.includes("which car");
    
    // WEATHER
    if (
      lower.includes("weather") ||
      lower.includes("temperature") ||
      lower.includes("forecast") ||
      lower.includes("temp") ||
      lower.includes("high") ||
      lower.includes("low") ||
      lower.includes("rain") ||
      lower.includes("snow") ||
      lower.includes("humidity") ||
      lower.includes("wind")
    ) {

      const weather = await getWeather("Fort Worth");
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

    // NEWS
if (
  lower.includes("news") ||
  lower.includes("headline") ||
  lower.includes("breaking")
) {
  let topic = "technology";

  if (lower.includes("ai")) {
    topic = "artificial intelligence";
  } else if (lower.includes("tech")) {
    topic = "technology";
  } else if (lower.includes("gaming")) {
    topic = "gaming";
  } else if (lower.includes("business")) {
    topic = "business";
  } else if (lower.includes("sports")) {
    topic = "sports";
  }

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
    

    // STOCKS
    const directTicker =
      /^[A-Z]{1,5}$/.test(message.trim());
    if (
      lower.includes("stock") ||
      lower.includes("ticker") ||
      lower.includes("share price") ||
      lower.includes("stockmarket") ||
      lower.includes("djia") ||
      lower.includes("dow") ||
      lower.includes("dow jones") ||
      lower.includes("nasdaq") ||
      lower.includes("s&p") ||
      lower.includes("sp500") ||
      directTicker
    ) {

      const stockMap = {
      aapl: "AAPL",
      apple: "AAPL",

      msft: "MSFT",
      microsoft: "MSFT",

      goog: "GOOG",
      google: "GOOG",

      amzn: "AMZN",
      amazon: "AMZN",

      tsla: "TSLA",
      tesla: "TSLA",

      nvda: "NVDA",
      nvidia: "NVDA",

      meta: "META",
      facebook: "META"
    };

    let symbol = null;
    const tickerMatch = message.match(/\b[A-Z]{1,5}\b/);

    if (tickerMatch) {
      symbol = tickerMatch[0];
      console.log("DETECTED TICKER:", symbol);
    }

    if (!symbol) {
      for (const [keyword, ticker] of Object.entries(stockMap)) {
        if (lower.includes(keyword)) {
          symbol = ticker;
          console.log("ALIAS MATCH:", symbol);
          break;
        }
      }
    }
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

      console.log(
        "STOCK NEWS:",
        JSON.stringify(stockNews, null, 2)
      );

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
    // SEARCH
    if (
      lower.startsWith("search ") ||
      lower.startsWith("look up ") ||
      lower.startsWith("find ")
    ) {
      let query = message;

      query = query.replace(/^search\s+/i, "");
      query = query.replace(/^look up\s+/i, "");
      query = query.replace(/^find\s+/i, "");

      const results = await webSearch(query);

      const searchAnswer = await askOllama(
        `You are an investigative research analyst.

        User Question:
        ${message}

        Search Results:
        ${JSON.stringify(results, null, 2)}

        Instructions:

        1. Extract the important facts.
        2. Compare the sources.
        3. Identify agreements.
        4. Identify contradictions.
        5. Determine which sources are most credible.
        6. Answer the user's question.
        7. Mention uncertainty when facts conflict.

        Provide a concise but intelligent response.
        `,
        model
      );

return {
  text: searchAnswer,
  model
};

    
}

   // OLLAMA FALLBACK   

   const decision = await askOllama(
   `You are a routing system.

   Determine whether the user needs:

   SEARCH = current events, news, live data, prices, products, shopping, sports scores, weather, current information, recent developments, or fact-checking.

   CHAT = explanations, conversations, definitions, how things work, opinions, brainstorming, coding help, writing, identity questions, capability questions, or general knowledge.

   Examples:

   "What's happening with NVIDIA today?" => SEARCH
   "Breaking AI news" => SEARCH
   "What's the weather?" => SEARCH
   "Find me the cheapest used Prius" => SEARCH

   "Who are you?" => CHAT
   "What's your primary function?" => CHAT
   "Explain how a manual transmission works." => CHAT
   "How does a turbocharger work?" => CHAT
   "Write me a Python script." => CHAT

   Question:
   ${message}

   Respond with ONLY one word:

   SEARCH
   or
   CHAT`,
   model
   );

   console.log("ROUTER:", decision);
   if (decision.trim().toUpperCase() === "SEARCH") {

     console.log("AI CHOSE SEARCH");

     const searchQuery = await askOllama(
     `
     You are a search query optimizer.

     User Question:
     ${message}

     Instructions:

     - Preserve the user's original intent.
     - Do not invent years.
     - Do not add dates unless explicitly stated.
     - Do not add assumptions.
     - Preserve important context such as:
       current
       latest
       recent
       today
       location names
       company names
     - Do not over-shorten the query.
     - Produce a search query a human would actually type into Google.
     - Preserve the user's intent.

     Examples:

     User:
     What's happening with NVIDIA today?

     Query:
     NVIDIA news today

     User:
     What's the biggest story in technology today?

     Query:
     latest technology news today

     User:
     I'm a DoorDash driver in Fort Worth. What's the smartest vehicle purchase under $10,000?

     Query:
     best used vehicle under 10000 for delivery driving Fort Worth

     Return ONLY the search query.
     `
     );

     console.log("SEARCH QUERY:", searchQuery);

     const cleanQuery = searchQuery
       .replace(/^"+|"+$/g, "")
       .trim();


     console.log("CLEAN QUERY:", cleanQuery);

     console.log("STARTING WEB SEARCH...");
     const results = await webSearch(cleanQuery);
     console.log("WEB SEARCH FINISHED");

     console.log("STARTING NEWS SEARCH...");
     const newsResults = await getNews(cleanQuery);
     console.log("NEWS SEARCH FINISHED");
     const hasWebResults =
       Array.isArray(results) &&
       results.length > 0 &&
       !results.error;

     const hasNewsResults =
       Array.isArray(newsResults) &&
       newsResults.length > 0 &&
       !newsResults.error;

     if (!hasWebResults && !hasNewsResults) {

       if (recommendationIntent) {

         const recommendationAnswer =
           await askOllama(
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
    text:
      "I couldn't retrieve reliable search results right now. Please try again in a moment.",
    model
  };
}

     console.log(
       "SEARCH RESULTS:",
       JSON.stringify(results, null, 2)
     );

     console.log(
       "NEWS RESULTS:",
       JSON.stringify(newsResults, null, 2)
     );
     console.log("WEB RESULTS:", results?.length);
     console.log("NEWS RESULTS:", newsResults?.length);

     const searchAnswer = await askOllama(
     `You are an investigative research analyst.

     User Question:
     ${message}

     Web Search Results:
     ${JSON.stringify(results, null, 2)}

     News Results:
     ${JSON.stringify(newsResults, null, 2)}

     Instructions:

     - Use both Web Search Results and News Results.
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

    // OLLAMA FALLBACK
    const answer = await askOllama(message, model);

    return {
      text: answer,
      model
    };

      } catch (err) {
        console.error(err);

        return {
          text: `Error: ${err.message}`,
          model: "Error"
        };
      }
  });
    ipcMain.handle("call-tool", async (event, payload) => {
  try {

    const { type, args } = payload;

    switch (type) {

      case "weather":
        return await getWeather(args.location);

      case "news":
        return await getNews(args.topic);

      case "stock":
        return await getStock(args.symbol);

      case "search":
        return await webSearch(args.query);

      default:
        return {
          error: "Unknown tool type"
        };
    }

  } catch (err) {

    return {
      error: err.message
    };
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
