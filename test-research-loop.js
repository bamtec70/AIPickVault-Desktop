"use strict";

/**
 * Tests for researchLoop.planTools() + router tool plans.
 * Run: node test-research-loop.js
 */

const assert = require("assert");
const { routeMessage } = require("./router");
const {
  planTools,
  refineNewsTopic,
  describePlan,
  MAX_STEPS
} = require("./researchLoop");

function planFor(utterance) {
  const route = routeMessage(utterance);
  return { route, plan: planTools(route, utterance) };
}

function expectTools(utterance, tools, intent) {
  const { route, plan } = planFor(utterance);
  if (intent) {
    assert.strictEqual(
      route.intent,
      intent,
      `"${utterance}" expected intent=${intent}, got ${route.intent}`
    );
  }
  const got = plan.map((s) => s.tool);
  assert.deepStrictEqual(
    got,
    tools,
    `"${utterance}" expected plan=${JSON.stringify(tools)}, got ${JSON.stringify(got)} from route ${JSON.stringify(route)}`
  );
  assert.ok(plan.length <= MAX_STEPS, "plan exceeds MAX_STEPS");
}

// Chitchat skips the heavy loop
expectTools("hi", [], "chat");
expectTools("hello", [], "chat");
expectTools("Who are you?", [], "chat");
expectTools("How does a turbocharger work?", [], "chat");

// Search: one-shot search
expectTools("search quantum computing", ["search"], "search");

// Search + news multi-step
expectTools("What's happening with DoorDash today?", ["search", "news"], "search");

// News alone
expectTools("tech news", ["news"], "news");
expectTools("breaking AI news", ["news"], "news");

// Weather one step
expectTools("What's the weather?", ["weather"], "weather");

// Stock: finance then news
expectTools("AAPL", ["stock", "news"], "stock");
expectTools("$NVDA", ["stock", "news"], "stock");

// Compare: parallel quotes + news (3 steps max)
{
  const { route, plan } = planFor("compare AAPL vs MSFT");
  assert.strictEqual(route.intent, "stock_compare");
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(plan[0].tool, "stock");
  assert.strictEqual(plan[1].tool, "stock");
  assert.strictEqual(plan[0].parallelGroup, "quotes");
  assert.strictEqual(plan[1].parallelGroup, "quotes");
  assert.strictEqual(plan[2].tool, "news");
}

// describePlan readable
{
  const { plan } = planFor("What's happening with DoorDash today?");
  assert.match(describePlan(plan), /Web search/);
  assert.match(describePlan(plan), /News/);
}

// refineNewsTopic never invents URLs; keeps base when empty
assert.strictEqual(refineNewsTopic("DoorDash", []), "DoorDash");
assert.strictEqual(
  refineNewsTopic("DoorDash", [{ title: "DoorDash shares jump after earnings | CNBC" }]).includes(
    "DoorDash"
  ),
  true
);

// Optional finance as 3rd research step when search + market words + known company
{
  const { route, plan } = planFor("search nvidia market outlook");
  assert.strictEqual(route.intent, "search");
  assert.ok(route.payload.tools.includes("search"));
  // May include news only if happening/today/etc — this utterance is search-only + stock
  assert.ok(plan.some((s) => s.tool === "search"));
  assert.ok(plan.some((s) => s.tool === "stock"));
  assert.ok(plan.length <= 3);
}

console.log("All research-loop tests passed.");
