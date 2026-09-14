// tools.js

// ⭐ Insert your REAL API keys here
require("dotenv").config();

const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const STOCK_API_KEY = process.env.STOCK_API_KEY;
const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// ⭐ Node v24+ has global fetch — no import needed

// WEATHER TOOL
async function getWeather(location) {
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

module.exports = {
  getWeather,
  getNews,
  getStock,
  webSearch
};
