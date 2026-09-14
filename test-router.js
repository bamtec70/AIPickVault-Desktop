"use strict";

/**
 * Utterance checks for routeMessage().
 * Run: node test-router.js
 */

const assert = require("assert");
const { routeMessage } = require("./router");

function expectIntent(utterance, intent, extra) {
  const route = routeMessage(utterance);
  assert.strictEqual(
    route.intent,
    intent,
    `"${utterance}" expected intent=${intent}, got ${JSON.stringify(route)}`
  );
  if (extra) extra(route);
}

// --- weather false positives (bare high/low/rain must NOT route weather)
expectIntent("What's the high today?", "chat");
expectIntent("high", "chat");
expectIntent("low", "chat");
expectIntent("rain", "chat");
expectIntent("I like rain", "chat");
expectIntent("high quality headphones", "chat");
expectIntent("The rain stopped mattering to me", "chat");

// --- real weather
expectIntent("What's the weather?", "weather");
expectIntent("What's the forecast for tomorrow?", "weather");
expectIntent("temperature in Dallas", "weather", (r) => {
  assert.match(r.payload.location, /Dallas/i);
});
expectIntent("What's the high in Fort Worth?", "weather", (r) => {
  assert.match(r.payload.location, /Fort Worth/i);
});
expectIntent("Is it going to rain tomorrow?", "weather");
expectIntent("How humid is it outside?", "weather");
expectIntent("Is it raining?", "weather");
expectIntent("wind speed today", "weather");

// --- tickers / aliases / compare
expectIntent("AAPL", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "AAPL");
});
expectIntent("aapl", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "AAPL");
});
expectIntent("apple stock", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "AAPL");
});
expectIntent("$NVDA", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "NVDA");
});
expectIntent("What's AAPL trading at?", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "AAPL");
});
expectIntent("tesla", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "TSLA");
});
expectIntent("apple", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "AAPL");
});
expectIntent("price of tesla", "stock", (r) => {
  assert.strictEqual(r.payload.symbol, "TSLA");
});
expectIntent("compare AAPL vs MSFT", "stock_compare", (r) => {
  assert.deepStrictEqual(r.payload.symbols, ["AAPL", "MSFT"]);
});
expectIntent("compare apple vs tesla", "stock_compare", (r) => {
  assert.deepStrictEqual(r.payload.symbols, ["AAPL", "TSLA"]);
});

// normal words must not become tickers
expectIntent("HOW ARE YOU", "chat");
expectIntent("IT", "chat");
expectIntent("Who are you?", "chat");
expectIntent("hi", "chat");
expectIntent("hello", "chat");
expectIntent("I ate an apple pie", "chat");

// --- news vs search vs chat
expectIntent("tech news", "news", (r) => {
  assert.strictEqual(r.payload.topic, "technology");
});
expectIntent("latest headlines", "news");
expectIntent("breaking AI news", "news", (r) => {
  assert.strictEqual(r.payload.topic, "artificial intelligence");
});
expectIntent("I have good news", "chat");

expectIntent("search quantum computing", "search", (r) => {
  assert.strictEqual(r.payload.query, "quantum computing");
  assert.deepStrictEqual(r.payload.tools, ["search"]);
});
expectIntent("look up best used Prius", "search");
expectIntent("find cheapest laptop", "search");
expectIntent("What's happening with DoorDash today?", "search", (r) => {
  assert.ok(r.payload.tools.includes("search"));
  assert.ok(r.payload.tools.includes("news"));
});

expectIntent("How does a turbocharger work?", "chat");
expectIntent("Write me a Python script", "chat");
expectIntent("Explain how a manual transmission works.", "chat");
expectIntent("What's your primary function?", "chat");

// stock ticker beats weather when both could match
expectIntent("AAPL", "stock");

// Factual refresh follow-ups (must not fall through to chat)
expectIntent("Did you consider what generation of Prius and battery recall?", "search", (r) => {
  assert.ok(r.payload.tools.includes("search"));
  assert.ok(r.payload.forceToolRefresh || r.payload.tools.includes("news"));
});
expectIntent("what about Prius battery recall?", "search", (r) => {
  assert.ok(r.payload.tools.includes("search"));
});
expectIntent("insurance quote for a used Prius", "search");


// Gig-vehicle domain upgrade (follow-ups without repeating DoorDash)
{
  const { ensureGigVehicleDomainRoute } = require("./domain/gigVehicle");
  const { planTools } = require("./researchLoop");
  const q = "Prius vs Corolla if you do ~40k miles/year, or cargo van for mixed days?";
  const forced = ensureGigVehicleDomainRoute(q, routeMessage(q), {});
  assert.strictEqual(forced.intent, "search");
  const plan = planTools(forced, q);
  assert.ok(plan.some((s) => s.tool === "domain"));
  // Recall still forces search tools, not domain-only
  const recall = "Did you consider what generation of Prius and battery recall?";
  const rRoute = routeMessage(recall);
  assert.strictEqual(rRoute.intent, "search");
  assert.ok(rRoute.payload.forceToolRefresh || rRoute.payload.tools.includes("search"));
}

// --- webpage / URL fetch intent ---
expectIntent("Take a look at my webpage: wethepeoplepress.com. What do you think?", "fetch", (r) => {
  assert.ok(r.payload.tools.includes("fetch"));
  assert.ok(r.payload.url && /wethepeoplepress\.com/i.test(r.payload.url));
});
expectIntent("https://example.com/about — review this site", "fetch", (r) => {
  assert.ok(r.payload.tools.includes("fetch"));
  assert.match(r.payload.url, /example\.com/i);
});
expectIntent("Check out my website www.example.org", "fetch", (r) => {
  assert.ok(r.payload.tools.includes("fetch"));
  assert.match(r.payload.url, /example\.org/i);
});
{
  const { extractUrlsFromMessage, isWebpageReviewIntent } = require("./router");
  const urls = extractUrlsFromMessage("Take a look at my webpage: wethepeoplepress.com. What do you think?");
  assert.ok(urls.some((u) => /wethepeoplepress\.com/i.test(u)));
  assert.strictEqual(
    isWebpageReviewIntent(
      "Take a look at my webpage: wethepeoplepress.com. What do you think?",
      "take a look at my webpage: wethepeoplepress.com. what do you think?"
    ),
    true
  );
}


// Year-recall + locate + shop
{
  const { ensureGigVehicleDomainRoute, isYearRecallAsk, isLocateRecommendedVehicleAsk } = require("./domain/gigVehicle");
  const { planTools } = require("./researchLoop");
  const yearsQ = "I forgot what years of Corrolas I'm searching for regarding gig work.";
  assert.strictEqual(isYearRecallAsk(yearsQ), true);
  const yRoute = ensureGigVehicleDomainRoute(yearsQ, routeMessage(yearsQ), {});
  assert.strictEqual(yRoute.intent, "search");
  assert.ok(planTools(yRoute, yearsQ).some((s) => s.tool === "domain"));

  const locQ = "Can you locate me the Toyota Carolla that you recommended from earlier?";
  assert.strictEqual(isLocateRecommendedVehicleAsk(locQ), true);
  expectIntent(locQ, "search");

  expectIntent(
    "Check Amazon and Walmart for me and let me know a few of the products you find for neodymium magnet.",
    "search"
  );

  const civicQ = "Find a 2018 Honda Civic under $12k near Fort Worth";
  assert.strictEqual(isLocateRecommendedVehicleAsk(civicQ), true);
  expectIntent(civicQ, "search");
  const { isPackBackedLocateAsk } = require("./domain/gigVehicle");
  assert.strictEqual(isPackBackedLocateAsk(civicQ), false);
  const fQ = "Locate a Ford F-150 under $15k";
  assert.strictEqual(isLocateRecommendedVehicleAsk(fQ), true);
  assert.strictEqual(isPackBackedLocateAsk(fQ), false);
  expectIntent(fQ, "search");

}

console.log("All router tests passed.");
