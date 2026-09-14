// tools.js

require("dotenv").config();

const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const SEARCH_API_KEY = process.env.SEARCH_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const MAX_FETCH_BYTES = 500000;
const MAX_TEXT_CHARS = 12000;
const FETCH_TIMEOUT_MS = 15000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const LISTING_HOST_RE =
  /(?:^|\.)(autotrader\.com|cars\.com|cargurus\.com|carvana\.com|facebook\.com|marketplace\.facebook\.com)$/i;

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

function isListingSiteUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.replace(/^www\./i, "");
    return LISTING_HOST_RE.test(host) || /marketplace/i.test(host);
  } catch (_) {
    return /autotrader\.com|cars\.com|cargurus\.com|carvana\.com|facebook\.com\/marketplace/i.test(
      String(url || "")
    );
  }
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

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

function pushListing(out, seen, item) {
  if (!item || typeof item !== "object") return;
  const year = item.year != null ? String(item.year) : "";
  const price = item.price != null ? String(item.price) : "";
  const mileage = item.mileage != null ? String(item.mileage) : "";
  const title = item.title || [year, item.make, item.model, item.trim].filter(Boolean).join(" ");
  const href = item.href || item.url || "";
  const key = `${title}|${price}|${mileage}|${href}`.toLowerCase();
  if (!title && !price) return;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    year: year || null,
    make: item.make || null,
    model: item.model || null,
    trim: item.trim || null,
    title: title || null,
    price: price || null,
    mileage: mileage || null,
    dealer: item.dealer || item.seller || null,
    location: item.location || null,
    href: href || null
  });
}

function walkJsonForListings(node, out, seen, depth) {
  if (depth > 10 || out.length >= 25) return;
  if (!node) return;
  if (Array.isArray(node)) {
    for (const el of node) walkJsonForListings(el, out, seen, depth + 1);
    return;
  }
  if (typeof node !== "object") return;

  const keys = Object.keys(node);
  const blob = keys.join(" ").toLowerCase();
  const looksVehicle =
    ("year" in node || "modelYear" in node) &&
    ("price" in node || "listingPrice" in node || "askPrice" in node || "derivedPrice" in node) &&
    ("make" in node || "model" in node || "trim" in node || "title" in node || "heading" in node);

  if (looksVehicle || (/\b(vehicle|listing|inventory)\b/.test(blob) && ("price" in node || "mileage" in node))) {
    const priceRaw =
      node.price ?? node.listingPrice ?? node.askPrice ?? node.derivedPrice ?? node.listPrice;
    let price = null;
    if (priceRaw != null && typeof priceRaw === "object") {
      price = priceRaw.value ?? priceRaw.amount ?? priceRaw.price ?? null;
    } else {
      price = priceRaw;
    }
    const milesRaw = node.mileage ?? node.miles ?? node.odometer ?? node.odometerValue;
    let mileage = null;
    if (milesRaw != null && typeof milesRaw === "object") {
      mileage = milesRaw.value ?? milesRaw.miles ?? null;
    } else {
      mileage = milesRaw;
    }
    pushListing(out, seen, {
      year: node.year || node.modelYear || node.model_year,
      make: node.make || (node.vehicle && node.vehicle.make),
      model: node.model || (node.vehicle && node.vehicle.model),
      trim: node.trim || node.trimName || (node.vehicle && node.vehicle.trim),
      title: node.title || node.heading || node.name,
      price,
      mileage,
      dealer: node.dealerName || node.dealer || (node.dealerInfo && node.dealerInfo.name) || node.sellerName,
      location: node.location || node.city || node.address || (node.dealerAddress && node.dealerAddress.city),
      href: node.url || node.href || node.vdpUrl || node.detailUrl || node.link
    });
  }

  for (const k of keys) {
    if (k === "parent" || k === "__proto__") continue;
    const v = node[k];
    if (v && typeof v === "object") walkJsonForListings(v, out, seen, depth + 1);
  }
}

function extractJsonLdListings(html) {
  const out = [];
  const seen = new Set();
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const parsed = safeJsonParse(m[1].trim());
    if (!parsed) continue;
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const n of nodes) {
      const graph = n && n["@graph"] ? n["@graph"] : [n];
      for (const g of graph) {
        const type = String((g && (g["@type"] || g.type)) || "").toLowerCase();
        if (type.includes("product") || type.includes("car") || type.includes("vehicle") || type.includes("offer")) {
          const offers = g.offers || g.offer;
          const offer = Array.isArray(offers) ? offers[0] : offers;
          pushListing(out, seen, {
            year: g.modelDate || g.vehicleModelDate || g.productionDate,
            make: g.brand && (g.brand.name || g.brand),
            model: g.model || g.name,
            trim: g.vehicleConfiguration || g.trim,
            title: g.name || g.title,
            price: offer && (offer.price || offer.lowPrice),
            mileage: g.mileageFromOdometer
              ? g.mileageFromOdometer.value || g.mileageFromOdometer
              : g.mileage,
            dealer: offer && offer.seller && (offer.seller.name || offer.seller),
            location: null,
            href: g.url || (offer && offer.url)
          });
        }
        walkJsonForListings(g, out, seen, 0);
      }
    }
  }
  return out;
}

function extractNextDataListings(html) {
  const out = [];
  const seen = new Set();
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return out;
  const parsed = safeJsonParse(m[1].trim());
  if (!parsed) return out;
  walkJsonForListings(parsed, out, seen, 0);
  return out;
}

function extractListingCandidatesFromHtml(html, pageUrl) {
  const listings = [];
  const seen = new Set();
  for (const L of extractJsonLdListings(html)) pushListing(listings, seen, L);
  for (const L of extractNextDataListings(html)) pushListing(listings, seen, L);

  // Regex fallbacks on raw HTML for common listing card patterns
  const priceRe = /\$\s?([\d,]{3,7})/g;
  const yearModelRe =
    /\b((?:19|20)\d{2})\s+(Toyota|Honda|Ford|Chevrolet|Chevy|Nissan|Hyundai|Kia|Mazda|Subaru|Volkswagen|VW|BMW|Mercedes[-\s]?Benz)?\s*(Corolla|Prius|Civic|Camry|Accord|Sentra|Elanra|Elantra|Soul|Mazda3|Impreza|Jetta)?\s*(LE|SE|XLE|XSE|EX|LX|Sport|L|S|Base)?\b/gi;
  let ym;
  const yearHits = [];
  while ((ym = yearModelRe.exec(html)) && yearHits.length < 20) {
    yearHits.push({
      year: ym[1],
      make: ym[2] || null,
      model: ym[3] || null,
      trim: ym[4] || null,
      index: ym.index
    });
  }
  for (const hit of yearHits) {
    const window = html.slice(hit.index, hit.index + 400);
    const priceM = window.match(/\$\s?([\d,]{3,7})/);
    const mileM = window.match(/([\d,]{2,6})\s*(?:mi|miles|mileage)\b/i);
    const hrefM = window.match(/href=["']([^"']+)["']/i);
    pushListing(listings, seen, {
      year: hit.year,
      make: hit.make,
      model: hit.model,
      trim: hit.trim,
      title: [hit.year, hit.make, hit.model, hit.trim].filter(Boolean).join(" "),
      price: priceM ? "$" + priceM[1] : null,
      mileage: mileM ? mileM[1] + " miles" : null,
      href: hrefM ? hrefM[1] : null
    });
  }

  // Suppress false "listings" that are clearly trim/package marketing only
  const filtered = listings.filter((L) => {
    const t = `${L.title || ""} ${L.trim || ""}`.toLowerCase();
    if (/make it mine|package only|build.?and.?price|trim level guide/i.test(t) && !L.price && !L.mileage) {
      return false;
    }
    return !!(L.price || L.mileage || (L.year && L.model));
  });

  return filtered.slice(0, 15);
}

function formatListingsForText(listings) {
  if (!listings || !listings.length) return "";
  return listings
    .map((L, i) => {
      const bits = [
        L.title || [L.year, L.make, L.model, L.trim].filter(Boolean).join(" "),
        L.price ? `price ${L.price}` : null,
        L.mileage ? `mileage ${L.mileage}` : null,
        L.dealer ? `dealer ${L.dealer}` : null,
        L.location ? `location ${L.location}` : null,
        L.href ? `link ${L.href}` : null
      ].filter(Boolean);
      return `${i + 1}. ${bits.join(" | ")}`;
    })
    .join("\n");
}

/**
 * Rewrite a listing-site results URL into a web-search query (year/make/model/zip).
 */
function listingSearchQueryFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.replace(/^www\./i, "");
    const path = u.pathname || "";
    const q = u.searchParams;
    const parts = [];

    let yearMin = q.get("year_min") || q.get("startYear") || q.get("yearMin");
    let yearMax = q.get("year_max") || q.get("endYear") || q.get("yearMax");
    let make = q.get("make") || q.get("makes[]") || q.get("makeCode");
    let model = q.get("model") || q.get("models[]") || q.get("modelCode");
    let zip = q.get("zip") || q.get("zipCode") || q.get("searchRadiusZip");
    let trim = q.get("trim") || null;
    const mileageMax = q.get("mileage_max") || q.get("mileage") || q.get("maxMileage");

    // Path patterns: /cars-for-sale/.../2014/toyota/corolla/le/fort-worth-tx
    const pathBits = path.split("/").filter(Boolean);
    for (let i = 0; i < pathBits.length; i++) {
      const b = decodeURIComponent(pathBits[i]);
      if (/^(19|20)\d{2}$/.test(b)) {
        if (!yearMin) yearMin = b;
        if (!yearMax) yearMax = b;
      }
      if (/^(toyota|honda|ford|chevrolet|nissan|hyundai|kia|mazda|subaru)$/i.test(b) && !make) make = b;
      if (/^(corolla|prius|civic|camry|accord|sentra|elantra|rav4)$/i.test(b) && !model) model = b;
      if (/^(le|se|xle|xse|ex|lx|sport)$/i.test(b) && !trim) trim = b;
      if (/-\w{2}$/i.test(b) && /fort-worth|dallas|arlington|alliance/i.test(b) && !zip) {
        parts.push(b.replace(/-/g, " "));
      }
    }

    // cars.com models[]=toyota-corolla
    if (model && /-/i.test(model)) {
      const mm = model.split("-");
      if (mm.length >= 2 && !make) {
        make = mm[0];
        model = mm.slice(1).join("-");
      } else if (mm.length >= 2) {
        model = mm[mm.length - 1];
      }
    }
    if (make && Array.isArray(make)) make = make[0];
    if (model && Array.isArray(model)) model = model[0];

    // Also read repeated makes[] / models[] from raw query string
    const raw = String(url);
    const makeM = raw.match(/makes?(?:%5B%5D|\[\])?=([^&]+)/i);
    const modelM = raw.match(/models?(?:%5B%5D|\[\])?=([^&]+)/i);
    if (makeM && !make) make = decodeURIComponent(makeM[1]);
    if (modelM && !model) {
      model = decodeURIComponent(modelM[1]);
      if (/toyota-corolla/i.test(model)) {
        make = make || "toyota";
        model = "corolla";
      }
    }

    if (yearMin && yearMax && yearMin !== yearMax) parts.push(`${yearMin}-${yearMax}`);
    else if (yearMin || yearMax) parts.push(yearMin || yearMax);
    if (make) parts.push(String(make).replace(/toyota-/i, ""));
    if (model) parts.push(String(model).replace(/^toyota-/i, ""));
    if (trim) parts.push(trim);
    parts.push("for sale");
    if (zip) parts.push(`near ${zip}`);
    else parts.push("Fort Worth TX 76177");
    if (mileageMax) parts.push(`under ${mileageMax} miles`);
    parts.push("site:" + host.replace(/^www\./, ""));

    const query = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return query || `used cars for sale Fort Worth 76177`;
  } catch (_) {
    return "used Toyota Corolla 2010-2015 for sale near 76177";
  }
}

/**
 * HTTP GET a public webpage and extract title + main text (scripts stripped).
 * Caps download size and extracted text. Clear error objects on failure.
 * Listing SERPs also try structured candidate extraction (JSON-LD / __NEXT_DATA__ / HTML).
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

  const listingSite = isListingSiteUrl(parsed.toString());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1"
      }
    });

    if (!res.ok) {
      return {
        error: `HTTP ${res.status} fetching ${parsed.toString()}`,
        url: parsed.toString(),
        status: res.status,
        listingSite,
        fallbackSearchQuery: listingSite ? listingSearchQueryFromUrl(parsed.toString()) : null,
        blocked: res.status === 403 || res.status === 429 || res.status === 503
      };
    }

    const buf = await res.arrayBuffer();
    const truncatedDownload = buf.byteLength > MAX_FETCH_BYTES;
    const slice = truncatedDownload ? buf.slice(0, MAX_FETCH_BYTES) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    const { title, text } = stripHtmlToText(html);

    const listings = listingSite ? extractListingCandidatesFromHtml(html, parsed.toString()) : [];
    const listingText = formatListingsForText(listings);
    const thinShell =
      (!text || text.length < 80) && listings.length === 0;

    if (thinShell) {
      return {
        error:
          "Could not extract readable listing text from the page (may be JavaScript-rendered or blocked).",
        url: parsed.toString(),
        finalUrl: res.url || parsed.toString(),
        title: title || null,
        listingSite,
        jsHeavy: true,
        listings: [],
        fallbackSearchQuery: listingSite ? listingSearchQueryFromUrl(parsed.toString()) : null
      };
    }

    // Prefer structured listing summary when present; keep page text for context.
    let combinedText = text;
    if (listingText) {
      combinedText =
        `LISTING CANDIDATES (extracted from page HTML/JSON — use these, not trim-package marketing):\n${listingText}\n\n` +
        `PAGE TEXT (may include filters/chrome):\n${text}`;
    } else if (listingSite) {
      combinedText =
        `NOTE: This appears to be a vehicle listing search page, but few structured sale cards were found in the HTML (often a JS-heavy shell). ` +
        `Summarize only vehicles-for-sale facts present below; do NOT pivot into new-car trim/package explainers. ` +
        `If there are no real asking prices/miles/dealer lines, say the page was thin and suggest a web search fallback.\n\n` +
        text;
    }

    return {
      url: parsed.toString(),
      finalUrl: res.url || parsed.toString(),
      title: title || null,
      text: combinedText.slice(0, MAX_TEXT_CHARS),
      truncated: truncatedDownload || combinedText.length >= MAX_TEXT_CHARS,
      listingSite,
      listings,
      jsHeavy: listingSite && listings.length === 0 && text.length < 400,
      fallbackSearchQuery:
        listingSite && listings.length === 0 ? listingSearchQueryFromUrl(parsed.toString()) : null
    };
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? "Timed out fetching page."
        : err && err.message
          ? err.message
          : String(err);
    return {
      error: msg,
      url: parsed.toString(),
      listingSite,
      fallbackSearchQuery: listingSite ? listingSearchQueryFromUrl(parsed.toString()) : null,
      blocked: true
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getWeather,
  getNews,
  getStock,
  webSearch,
  fetchWebpage,
  isListingSiteUrl,
  listingSearchQueryFromUrl,
  extractListingCandidatesFromHtml,
  stripHtmlToText
};
