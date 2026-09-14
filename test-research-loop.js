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
  extractBudget,
  extractGigUseCase,
  rankWebResultsForSynth,
  MAX_STEPS
} = require("./researchLoop");
const { createDurableMemory } = require("./durableMemory");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

assert.strictEqual(refineNewsTopic("DoorDash", []), "DoorDash");
assert.strictEqual(
  refineNewsTopic("DoorDash", [{ title: "DoorDash shares jump after earnings | CNBC" }]).includes("DoorDash"),
  true
);

{
  const { route, plan } = planFor("search nvidia market outlook");
  assert.strictEqual(route.intent, "search");
  assert.ok(route.payload.tools.includes("search"));
  assert.ok(plan.some((s) => s.tool === "search"));
  assert.ok(plan.some((s) => s.tool === "stock"));
  assert.ok(plan.length <= 3);
}

// --- Query rewriting: Blake DoorDash prompt extracts budget + gig ---
{
  const door =
    "Since I drive for Doordash, Uber, and other last mile gig delivery platforms, I need to know the best car to use that's under $10000. I'm looking at overall annual costs to run the vehicle along with reliability and maintenance.";
  const rw = rewriteSearchQuery(door, { wantsRecommendation: true });
  assert.ok(rw.rewritten, "DoorDash ask should be rewritten");
  assert.strictEqual(rw.budget, 10000);
  assert.ok(rw.gig.isGig, "should detect gig use-case");
  assert.ok(rw.gig.platforms.includes("DoorDash") || /DoorDash/i.test(rw.gig.label));
  assert.ok(
    !/Since drive Doordash/i.test(rw.primary),
    `must NOT be naive stopword garbage: ${rw.primary}`
  );
  assert.match(rw.primary, /DoorDash|Uber|used cars/i);
  assert.match(rw.primary, /under\s*10000|10000/i);
  assert.ok(rw.queries.length >= 2, "need multi-angle queries");
  const joined = rw.queries.join(" | ");
  assert.match(joined, /under\s*10000|10000/);
  assert.match(joined, /reliab|maintenance|ownership|cost/i);
  assert.ok(rw.alternate, "should offer an alternate query");
  assert.match(rw.alternate, /reliab|maintenance|mileage|cost/i);
}

{
  const door = "What's the best car to use for Doordash and Uber Eats that's under $10000?";
  const rw = rewriteSearchQuery(door, { wantsRecommendation: true });
  assert.ok(rw.rewritten);
  assert.strictEqual(extractBudget(door), 10000);
  assert.match(rw.primary, /DoorDash|Uber|used cars/i);
  assert.match(rw.primary, /10000/);
  assert.ok(!/^What's the best/i.test(rw.primary));
}

{
  const rw = rewriteSearchQuery("quantum computing", { wantsRecommendation: false });
  assert.match(rw.primary, /quantum/i);
  assert.match(rw.primary, /computing/i);
}

// --- Recommendation multi-step: ≥3 when cost/reliability ---
{
  const door =
    "Since I drive for Doordash, Uber, and other last mile gig delivery platforms, I need to know the best car to use that's under $10000. I'm looking at overall annual costs to run the vehicle along with reliability and maintenance.";
  const { route, plan } = planFor(door);
  assert.strictEqual(route.intent, "search");
  assert.strictEqual(route.payload.wantsRecommendation, true);
  assert.ok(
    plan.length >= 3,
    `cost/reliability gig rec should plan ≥3 steps, got ${plan.length}: ${describePlan(plan)}`
  );
  assert.ok(plan.filter((s) => s.tool === "search").length >= 2);
  const queries = plan.filter((s) => s.tool === "search").map((s) => s.args.query);
  const blob = queries.join(" ");
  assert.match(blob, /10000/);
  assert.match(blob, /DoorDash|Uber|reliab|ownership|maintenance|mileage/i);
  assert.ok(!/^Since I drive/i.test(queries[0]));
  assert.ok(!/Since drive Doordash/i.test(blob));
}

{
  const door = "What's the best car to use for Doordash and Uber Eats that's under $10000?";
  const { route, plan } = planFor(door);
  assert.strictEqual(route.payload.wantsRecommendation, true);
  assert.ok(plan.length >= 2);
  assert.ok(plan.filter((s) => s.tool === "search").length >= 2);
  const q0 = plan[0].args.query;
  assert.ok(q0.length < door.length);
  assert.ok(!/^What's the best/i.test(q0));
  assert.match(q0, /car|DoorDash|used|10000/i);
}

{
  const { plan } = planFor("best used laptop under $500");
  assert.ok(plan.length >= 2, "budget recommendation needs ≥2 steps");
}

// --- Synthesis prompt: forbid leading with no-tool-results meta ---
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
  assert.match(prompt, /NEVER open with/i);
  assert.match(prompt, /No tool results/i);
  assert.match(prompt, /Never invent URLs/i);
  assert.match(prompt, /Best Choice|Best pick/i);
  assert.match(prompt, /Fort Worth|76177/i);
  assert.match(prompt, /foreign imports to avoid/i);
  assert.match(prompt, /tradeoff|Think hard|Challenge weak/i);
  assert.ok(!/Use ONLY facts present/i.test(prompt));
}

// Rank demotes app-store spam
{
  const ranked = rankWebResultsForSynth([
    { title: "DoorDash APK", link: "https://play.google.com/store/apps/details?id=dd", snippet: "download" },
    { title: "Best used cars for delivery", link: "https://www.edmunds.com/car-news/", snippet: "Corolla Civic reliability MPG" }
  ]);
  assert.match(ranked[0].link, /edmunds/i);
}

// Durable memory learns gig + budget + corrections
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aipick-mem-"));
  const mem = createDurableMemory(() => tmp);
  const blake =
    "Since I drive for Doordash, Uber, and Roadie last mile gig delivery, best car under $10000 looking at annual costs reliability maintenance. I have a cargo van sometimes.";
  const { learned } = mem.learnFromUserMessage(blake);
  assert.ok(learned.length >= 1);
  const snap = mem.getSnapshot();
  assert.ok(snap.work.platforms.includes("DoorDash"));
  assert.ok(snap.work.platforms.includes("Uber") || snap.work.platforms.includes("Roadie"));
  assert.ok(snap.preferences.some((p) => /10000|budget/i.test(p)) || snap.preferences.some((p) => /annual cost/i.test(p)));
  mem.learnFromUserMessage("that was crap — don't call Hyundai a foreign import to avoid");
  const suffix = mem.buildSystemSuffix();
  assert.match(suffix, /DoorDash|gig|76177|Fort Worth|foreign import|tool-failure|Known user context/i);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("All research-loop tests passed.");
