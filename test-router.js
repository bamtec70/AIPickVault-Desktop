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

console.log("All router tests passed.");
