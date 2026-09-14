// tools.js

require("dotenv").config();

const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const MAX_FETCH_BYTES = 500000;
const MAX_TEXT_CHARS = 12000;
const FETCH_TIMEOUT_MS = 15000;

function missingKey(name) {
  return { error: `${name} is not configured. Add it to your .env file.` };
}

// WEATHER TOOL
async function getWeather(location) {
  if (!WEATHER_API_KEY) return missingKey("WEATHER_API_KEY");

  const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${encodeURIComponent(location)}&days=3`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    return { error: data.error.message };
  }

  return {
    location: data.location?.name,

    current: {
      temp_f: data.current?.temp_f,
      condition: data.current?.condition?.text
    },

    today: {
      high_f: data.forecast?.forecastday?.[0]?.day?.maxtemp_f,
      low_f: data.forecast?.forecastday?.[0]?.day?.mintemp_f,
      condition:
        data.forecast?.forecastday?.[0]?.day?.condition?.text
    },

    tomorrow: {
      high_f: data.forecast?.forecastday?.[1]?.day?.maxtemp_f,
      low_f: data.forecast?.forecastday?.[1]?.day?.mintemp_f,
      condition:
        data.forecast?.forecastday?.[1]?.day?.condition?.text
    }
  };
}

// NEWS TOOL
async function getNews(topic) {
  if (!NEWS_API_KEY) return missingKey("NEWS_API_KEY");

  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&apiKey=${NEWS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== "ok") {
    return { error: data.message || "News API error" };
  }

  return (data.articles || []).slice(0, 5).map(a => ({
    title: a.title,
    source: a.source?.name,
    url: a.url
  }));
}

// STOCK TOOL
async function getStock(symbol) {
  if (!FINNHUB_API_KEY) return missingKey("FINNHUB_API_KEY");

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  console.log(
    "FINNHUB STOCK DATA:",
    JSON.stringify(data, null, 2)
  );

  if (!data || data.c === 0) {
    return {
      error: "No stock data found"
    };
  }

  return {
    symbol,

    price: data.c,
    change: data.d,
    changePercent: `${data.dp}%`,

    open: data.o,
    high: data.h,
    low: data.l,
    previousClose: data.pc
  };
}

// SEARCH TOOL
async function webSearch(query) {
  if (!SEARCH_API_KEY) return missingKey("SEARCH_API_KEY");

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SEARCH_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    return { error: data.error };
  }

  return (data.organic_results || []).slice(0, 5).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet
  }));
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function stripHtmlToText(html) {
  let s = String(html || "");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim()
    : "";

  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  const mainMatch =
    s.match(/<main\b[^>]*>[\s\S]*?<\/main>/i) ||
    s.match(/<article\b[^>]*>[\s\S]*?<\/article>/i);
  if (mainMatch) s = mainMatch[0];

  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).replace(/\s+/g, " ").trim();
  return { title, text: s.slice(0, MAX_TEXT_CHARS) };
}

/**
 * HTTP GET a public webpage and extract title + main text (scripts stripped).
 * Caps download size and extracted text. Clear error objects on failure.
 */
async function fetchWebpage(url) {
  let target = String(url || "").trim();
  if (!target) return { error: "No URL provided." };
  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target.replace(/^\/\//, "");
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch (_) {
    return { error: "Invalid URL.", url: target };
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { error: "Only http(s) URLs are supported.", url: parsed.toString() };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "AIPickVault-Desktop/1.0 (+local research assistant; Blake Mauldin)",
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.7"
      }
    });

    if (!res.ok) {
      return {
        error: `HTTP ${res.status} fetching ${parsed.toString()}`,
        url: parsed.toString(),
        status: res.status
      };
    }

    const buf = await res.arrayBuffer();
    const truncatedDownload = buf.byteLength > MAX_FETCH_BYTES;
    const slice = truncatedDownload ? buf.slice(0, MAX_FETCH_BYTES) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    const { title, text } = stripHtmlToText(html);

    if (!text || text.length < 40) {
      return {
        error:
          "Could not extract readable text from the page (may be JavaScript-rendered or blocked).",
        url: parsed.toString(),
        finalUrl: res.url || parsed.toString(),
        title: title || null
      };
    }

    return {
      url: parsed.toString(),
      finalUrl: res.url || parsed.toString(),
      title: title || null,
      text,
      truncated: truncatedDownload || text.length >= MAX_TEXT_CHARS
    };
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Timed out fetching page."
        : err && err.message
          ? err.message
          : String(err);
    return { error: msg, url: parsed.toString() };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getWeather,
  getNews,
  getStock,
  webSearch,
  fetchWebpage
};
