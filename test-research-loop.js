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
  rewriteSearchQuery,
  buildSynthesisPrompt,
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

// Search: one-shot search (no recommendation → single step OK)
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
  assert.ok(plan.some((s) => s.tool === "search"));
  assert.ok(plan.some((s) => s.tool === "stock"));
  assert.ok(plan.length <= 3);
}

// --- Query rewriting ---
{
  const door =
    "What's the best car to use for Doordash and Uber Eats that's under $10000?";
  const rw = rewriteSearchQuery(door, { wantsRecommendation: true });
  assert.ok(rw.rewritten, "DoorDash ask should be rewritten");
  assert.ok(
    !rw.primary.includes("What's") && !rw.primary.includes("that's"),
    `primary should not be the essay: ${rw.primary}`
  );
  assert.match(rw.primary, /DoorDash|Doordash|doordash/i);
  assert.match(rw.primary, /under\s*10000|under\s*\$?10000|10000/i);
  assert.ok(
    rw.primary.split(/\s+/).length <= 12,
    `primary too long: ${rw.primary}`
  );
  assert.ok(rw.alternate, "should offer an alternate query");
  assert.match(rw.alternate, /gig|delivery|cheap|reliable|used/i);
}

{
  // Short keyword queries stay tight (may still normalize slightly)
  const rw = rewriteSearchQuery("quantum computing", {
    wantsRecommendation: false
  });
  assert.match(rw.primary, /quantum/i);
  assert.match(rw.primary, /computing/i);
}

// --- Recommendation multi-step planning ---
{
  const door =
    "What's the best car to use for Doordash and Uber Eats that's under $10000?";
  const { route, plan } = planFor(door);
  assert.strictEqual(route.intent, "search");
  assert.strictEqual(route.payload.wantsRecommendation, true);
  assert.ok(
    plan.length >= 2,
    `recommendation should plan ≥2 steps, got ${plan.length}: ${describePlan(plan)}`
  );
  assert.ok(plan.every((s) => s.tool === "search" || s.tool === "news"));
  assert.ok(plan.filter((s) => s.tool === "search").length >= 2);
  // Must not pass the raw essay as SerpAPI query
  const q0 = plan[0].args.query;
  assert.ok(
    q0.length < door.length,
    `query should be shorter than essay: ${q0}`
  );
  assert.ok(
    !/^What's the best/i.test(q0),
    `must not use raw essay as query: ${q0}`
  );
  assert.match(q0, /car|DoorDash|used|10000/i);
}

{
  const { plan } = planFor("best used laptop under $500");
  assert.ok(plan.length >= 2, "budget recommendation needs ≥2 steps");
  assert.ok(!/^best used laptop under/i.test(plan[0].args.query) || plan[0].args.query.split(/\s+/).length <= 10);
}

// --- Synthesis prompt: no dead-end on thin results ---
{
  const prompt = buildSynthesisPrompt(
    "What's the best car for DoorDash under $10000?",
    "search",
    {
      web: [
        {
          title: "Lexus ES 300h for rideshare",
          link: "https://example.com/lexus",
          snippet: "Highlander discussion"
        }
      ],
      news: null,
      stocks: {},
      weather: null,
      errors: []
    },
    true
  );
  assert.match(prompt, /do NOT refuse|best-effort|general knowledge/i);
  assert.match(prompt, /Never invent URLs/i);
  assert.match(prompt, /Best Choice/i);
  assert.ok(!/Use ONLY facts present/i.test(prompt));
}

console.log("All research-loop tests passed.");
