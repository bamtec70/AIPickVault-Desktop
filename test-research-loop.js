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
  MAX_STEPS,
  runResearchLoop
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

// --- Knowledge-first: gig/vehicle advice uses domain pack (not multi-search) ---
{
  const door =
    "Since I drive for Doordash, Uber, and other last mile gig delivery platforms, I need to know the best car to use that's under $10000. I'm looking at overall annual costs to run the vehicle along with reliability and maintenance.";
  const { route, plan } = planFor(door);
  assert.strictEqual(route.intent, "search");
  assert.strictEqual(route.payload.wantsRecommendation, true);
  assert.ok(
    plan.some((s) => s.tool === "domain"),
    `gig rec should be knowledge-first (domain pack), got: ${describePlan(plan)}`
  );
  assert.ok(
    !plan.some((s) => s.tool === "search"),
    "general gig advice should NOT blast SerpAPI — pack first"
  );
}

{
  const door = "What's the best car to use for Doordash and Uber Eats that's under $10000?";
  const { route, plan } = planFor(door);
  assert.strictEqual(route.payload.wantsRecommendation, true);
  assert.ok(plan.some((s) => s.tool === "domain"));
  assert.ok(!plan.some((s) => s.tool === "search"));
}

{
  // Non-vehicle budget rec can still use multi search
  const { plan } = planFor("best used laptop under $500");
  assert.ok(plan.length >= 1, "budget recommendation needs a plan");
  assert.ok(plan.some((s) => s.tool === "search"));
}

// --- Hard same-subject follow-ups: Prius vs Corolla / mileage / van → domain (not plain chat) ---
{
  const { ensureGigVehicleDomainRoute, shouldUseKnowledgeFirst } = require("./domain/gigVehicle");
  const q =
    "Prius vs Corolla if you do ~40k miles/year, or would a cargo van still win for mixed gig days?";
  const raw = routeMessage(q);
  assert.strictEqual(raw.intent, "chat", "bare router may still say chat before ensure");
  const forced = ensureGigVehicleDomainRoute(q, raw, {});
  assert.strictEqual(forced.intent, "search", "must upgrade to search for domain pack");
  assert.ok(forced.payload.domainPackPreferred || forced.payload.wantsRecommendation);
  assert.strictEqual(shouldUseKnowledgeFirst(q, forced), true);
  const plan = planTools(forced, q);
  assert.ok(plan.some((s) => s.tool === "domain"), "40k Prius vs Corolla → domain, got: " + describePlan(plan));
  assert.ok(!plan.some((s) => s.tool === "search"), "general advice must not SerpAPI-blast");
}
{
  // Conversation context: short follow-up after gig-car thread still uses domain
  const { ensureGigVehicleDomainRoute } = require("./domain/gigVehicle");
  const hist = [
    { role: "user", content: "best car for DoorDash under $10000 looking at annual cost reliability" },
    { role: "assistant", content: "Prius Gen3 if battery SOH verified, else Corolla." }
  ];
  const q = "What about at 40k miles a year?";
  const forced = ensureGigVehicleDomainRoute(q, routeMessage(q), { conversationHistory: hist });
  assert.strictEqual(forced.intent, "search");
  const plan = planTools(forced, q);
  assert.ok(plan.some((s) => s.tool === "domain"), "history follow-up → domain, got: " + describePlan(plan));
}

// --- Verification follow-ups FORCE search (recall / price / listing) ---
{
  const recall = "Did you consider what generation of Prius and battery recall?";
  const { route, plan } = planFor(recall);
  assert.strictEqual(route.intent, "search", "recall follow-up must be search not chat");
  assert.ok(route.payload.forceToolRefresh || plan.some((s) => s.tool === "search"));
  assert.ok(plan.some((s) => s.tool === "search"), "must run search for NHTSA/recall verify");
  assert.ok(!plan.some((s) => s.tool === "domain"), "verification is tools, not domain-only");
}
{
  const q = "what about Prius battery recall?";
  const { route, plan } = planFor(q);
  assert.strictEqual(route.intent, "search");
  assert.ok(plan.some((s) => s.tool === "search"));
  assert.ok(plan.some((s) => s.tool === "news") || plan.filter((s) => s.tool === "search").length >= 1);
}
{
  const q = "insurance quote for a used Prius in Fort Worth";
  const { route, plan } = planFor(q);
  assert.strictEqual(route.intent, "search");
  assert.ok(plan.some((s) => s.tool === "search"));
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
  assert.match(prompt, /Never invent URLs|invent listing/i);
  assert.match(prompt, /Best Choice|Best pick/i);
  assert.match(prompt, /Fort Worth|76177/i);
  assert.match(prompt, /foreign imports to avoid/i);
  assert.match(prompt, /tradeoff|Think hard|Challenge weak/i);
  assert.match(prompt, /Sourced vs estimate|estimates clearly/i);
  assert.match(prompt, /NHTSA|recall campaign/i);
  assert.match(prompt, /ANTI-FAKE-STATS|Never invent SOH|SOH percentages|failure probabilities|reliability index/i);
  assert.match(prompt, /double-count|tires twice/i);
  assert.match(prompt, /for-sale|verified at dealer|Autotrader|Cars\.com/i);
  assert.match(prompt, /domain knowledge pack|Knowledge-first/i);
  assert.ok(!/Use ONLY facts present/i.test(prompt));
}

// Domain pack loads and covers specialist topics
{
  const { loadGigVehicleDomainPack, shouldUseKnowledgeFirst } = require("./domain/gigVehicle");
  const { needsFactualRefresh } = require("./router");
  const pack = loadGigVehicleDomainPack();
  assert.match(pack, /Prius/i);
  assert.match(pack, /Corolla|Civic/i);
  assert.match(pack, /cargo van/i);
  assert.match(pack, /annual cost|Fuel|Insurance|Maintenance|Tires/i);
  assert.match(pack, /Never invent NHTSA|never invent/i);
  assert.match(pack, /Endorsed heuristics|Blake endorsed|2026-09-14/i);
  assert.match(pack, /Prius Gen 3|Gen 3.*2010|2010.?2015/i);
  assert.match(pack, /Corolla 2010.?2015|safest default/i);
  assert.match(pack, /25.?30k|25k.?30k/i);
  assert.match(pack, /oil dilution/i);
  assert.match(pack, /fuel penalty/i);
  assert.strictEqual(shouldUseKnowledgeFirst("best car for DoorDash under $10000", { intent: "search", payload: { wantsRecommendation: true } }), true);
  assert.strictEqual(shouldUseKnowledgeFirst("Prius vs Corolla if you do ~40k miles/year", { intent: "search", payload: { wantsRecommendation: true } }), true);
  assert.strictEqual(needsFactualRefresh("what about Prius battery recall?"), true);
  assert.strictEqual(shouldUseKnowledgeFirst("what about Prius battery recall?", { intent: "search", payload: { forceToolRefresh: true } }), false);
}

// Durable memory seed profile
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aipick-seed-"));
  const mem = createDurableMemory(() => tmp);
  const seeded = mem.ensureSeedProfile();
  assert.ok(seeded.added.length >= 1);
  const snap = mem.getSnapshot();
  assert.ok(snap.work.platforms.includes("Roadie"));
  assert.ok(snap.work.platforms.includes("Amazon Flex"));
  assert.ok(snap.work.vehicleNotes.some((v) => /cargo van/i.test(v)));
  assert.ok(snap.work.vehicleNotes.some((v) => /10k|10000/i.test(v)));
  fs.rmSync(tmp, { recursive: true, force: true });
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

// Pack-only synthesis: status note + Sourced vs estimate must not invent tool sources
(async () => {
  const notes = [];
  const fakeAsk = async () => "ok";
  const out = await runResearchLoop({
    message: "What's the best car for DoorDash under $10000 looking at annual cost reliability maintenance?",
    route: { intent: "search", payload: { wantsRecommendation: true, query: "best car DoorDash under 10000", tools: ["search"] } },
    model: "test",
    askOllama: fakeAsk,
    tools: {
      webSearch: async () => { throw new Error("should not search"); },
      getNews: async () => [],
      getStock: async () => null,
      getWeather: async () => null
    },
    stream: { note: (n) => notes.push(String(n)), chunk() {} }
  });
  assert.ok(out.plan.some((s) => s.tool === "domain"));
  assert.ok(notes.some((n) => /Using gig-vehicle specialist knowledge/i.test(n)), "notes=" + JSON.stringify(notes));
  assert.ok(!notes.some((n) => /Synthesizing from .*source/i.test(n)), "must not say synthesizing from tool sources on pack-only");
  const prompt = buildSynthesisPrompt(
    "What's the best car for DoorDash under $10000?",
    "search",
    { web: null, news: null, stocks: {}, weather: null, domainPack: require("./domain/gigVehicle").loadGigVehicleDomainPack(), errors: [] },
    true
  );
  assert.match(prompt, /PACK-ONLY|pack heuristic/i);
  assert.match(prompt, /Do NOT invent TDI|DFW market scrapes|fake citations/i);
  assert.match(prompt, /SOH %|failure probabilit|reliability index|invented %|Never invent SOH/i);
  console.log("All research-loop tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
