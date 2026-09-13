// tools.js

// ⭐ Insert your REAL API keys here
const WEATHER_API_KEY = "0b721eb18473448286623712261009";            // weatherapi.com
const NEWS_API_KEY    = "602dbf36ebc94b14ba488d39e3b5574b";          // newsapi.org
const STOCK_API_KEY   = "CSF3BZNH4EJ4W4RW";                          // alphaadvantage.co
const SEARCH_API_KEY  = "b0954d6f9afa562f456e118ebfcefc2453df98bb09135ab5db25d8ab24c7173d"; // serpapi.com

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
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${STOCK_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  console.log(
    "STOCK DATA:",
    JSON.stringify(data, null, 2)
  );

  const quote = data["Global Quote"];

  if (!quote || Object.keys(quote).length === 0) {
    return {
      error: "No stock data found"
    };
  }

  return {
    symbol: quote["01. symbol"],
    price: quote["05. price"],
    change: quote["09. change"],
    changePercent: quote["10. change percent"]
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
