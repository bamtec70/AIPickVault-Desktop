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
  buildFetchSynthesisPrompt,
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
  assert.match(prompt, /Illustrative ranges|clearly labeled estimate|prefer qualitative/i);
  assert.match(prompt, /hard SOH cutoff|SOH < 80%|never invent ZIP|76102|40k/i);
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
  assert.match(pack, /40k|~40k/i);
  assert.match(pack, /76177/i);
  assert.match(pack, /76102|ZIP band/i);
  assert.match(pack, /SOH.*80%|hard cutoff|no hard/i);
  assert.match(pack, /qualitative|hundreds of gallons|meaningful/i);
  assert.match(pack, /Illustrative ranges|clearly labeled estimate/i);
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


// --- URL / webpage fetch plan ---
expectTools(
  "Take a look at my webpage: wethepeoplepress.com. What do you think?",
  ["fetch"],
  "fetch"
);
{
  const { route, plan } = planFor("https://example.com — what do you think of this site?");
  assert.strictEqual(route.intent, "fetch");
  assert.deepStrictEqual(plan.map((s) => s.tool), ["fetch"]);
  assert.ok(route.payload.url && /example\.com/i.test(route.payload.url));
}

// Weather synthesis progress should not say "Synthesizing from tool sources"
async function __weatherProgressTest() {
  const notes = [];
  const out = await runResearchLoop({
    message: "What's the weather like?",
    route: { intent: "weather", payload: { location: "Fort Worth", tools: ["weather"] } },
    model: "test",
    askOllama: async () => "Sunny in Fort Worth.",
    tools: {
      webSearch: async () => [],
      getNews: async () => [],
      getStock: async () => null,
      getWeather: async () => ({
        location: "Fort Worth",
        current: { temp_f: 98, condition: "Sunny" },
        today: { high_f: 99, low_f: 78, condition: "Sunny" },
        tomorrow: { high_f: 97, low_f: 77, condition: "Partly cloudy" }
      }),
      fetchWebpage: async () => ({ error: "should not fetch" })
    },
    stream: { note: (n) => notes.push(String(n)), chunk() {} }
  });
  assert.ok(out.plan.some((s) => s.tool === "weather"));
  assert.ok(notes.some((n) => /Checking weather/i.test(n)), "notes=" + JSON.stringify(notes));
  assert.ok(notes.some((n) => /Summarizing weather/i.test(n)), "notes=" + JSON.stringify(notes));
  assert.ok(!notes.some((n) => /Synthesizing from .*source/i.test(n)), "must not say synthesizing from tool sources for weather");
}

// Fetch plan executes fetchWebpage and reviews page (not vehicle refusal)
async function __fetchPageTest() {
  const notes = [];
  let capturedPrompt = "";
  const out = await runResearchLoop({
    message: "Take a look at my webpage: wethepeoplepress.com. What do you think?",
    route: {
      intent: "fetch",
      payload: {
        url: "https://wethepeoplepress.com",
        urls: ["https://wethepeoplepress.com"],
        tools: ["fetch"]
      }
    },
    model: "test",
    askOllama: async (prompt) => {
      capturedPrompt = String(prompt || "");
      return "Solid patriotic news site; clear headline hierarchy.";
    },
    tools: {
      webSearch: async () => [],
      getNews: async () => [],
      getStock: async () => null,
      getWeather: async () => null,
      fetchWebpage: async (url) => ({
        url,
        finalUrl: url,
        title: "We The People Press",
        text: "Independent news and commentary. Headlines about liberty, local government, and civic engagement. Subscribe for updates.",
        truncated: false
      })
    },
    stream: { note: (n) => notes.push(String(n)), chunk() {} }
  });
  assert.ok(out.plan.some((s) => s.tool === "fetch"));
  assert.ok(notes.some((n) => /Fetching webpage|Reviewing page/i.test(n)), "notes=" + JSON.stringify(notes));
  assert.match(capturedPrompt, /We The People Press|Independent news/i);
  assert.match(capturedPrompt, /Never say you cannot view websites|CAN view\/analyze websites/i);
  assert.ok(!/capabilities are limited to/i.test(capturedPrompt));
  assert.ok(!/I cannot view or analyze websites/i.test(capturedPrompt));
}

// System prompt is general research assistant, not vehicle-only
{
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert.match(mainSrc, /general local research assistant/i);
  assert.match(mainSrc, /Never claim you are limited to vehicle/i);
  assert.match(mainSrc, /Never say you cannot view or analyze websites/i);
  const weatherPrompt = buildSynthesisPrompt(
    "What's the weather like?",
    "weather",
    {
      web: null,
      news: null,
      stocks: {},
      weather: { location: "Fort Worth", current: { temp_f: 90, condition: "Sunny" } },
      page: null,
      errors: []
    },
    false
  );
  assert.match(weatherPrompt, /Summarize the weather|Weather data/i);
  assert.ok(!/Lead with a direct recommendation ranked by overall annual cost/i.test(weatherPrompt));
  assert.ok(!/gig-vehicle specialist pack/i.test(weatherPrompt));
}


// Pack-only synthesis: status note + Sourced vs estimate must not invent tool sources
(async () => {
  await __weatherProgressTest();
  await __fetchPageTest();
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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// --- Locate + budget: rewrite must keep under-$10k ---
{
  const msg = "I need to locate a Toyota Corolla for $10k or less. Advise me and find for me.";
  assert.strictEqual(extractBudget(msg), 10000, "extractBudget should parse $10k or less");
  const rw = rewriteSearchQuery(msg, { wantsRecommendation: true });
  assert.strictEqual(rw.budget, 10000);
  const joined = rw.queries.join(" | ");
  assert.match(joined, /under\s+10000|price under\s+10000/i, "locate rewrite must preserve budget: " + joined);
  assert.match(rw.primary, /Corolla/i);
  assert.match(rw.primary, /under\s+10000/i);
  assert.ok(
    rw.queries.some((q) => /autotrader/i.test(q) && /under\s+10000|price under/i.test(q)),
    "autotrader query should include price under 10000: " + joined
  );
  assert.ok(!/mislabeled/i.test(joined));

  const prompt = buildSynthesisPrompt(msg, "search", { web: [{ title: "Edmunds Corolla pricing", url: "https://www.edmunds.com/toyota/corolla/", snippet: "average price guide" }], news: null, stocks: {}, weather: null, page: null, domainPack: "pack", errors: [] }, true);
  assert.match(prompt, /LOCATE\/FIND LISTING bans|no listings exist/i);
  assert.match(prompt, /mislabeled year|live listing cards/i);
  assert.match(prompt, /under \$10000|max price 10000/i);
  assert.match(prompt, /2010.?2015 LE\/SE/i);
}

// Listing URL → search fallback query + fetch synth rules
{
  const { listingSearchQueryFromUrl, isListingSiteUrl } = require("./tools");
  const { buildFetchSynthesisPrompt } = require("./researchLoop");
  const url = "https://www.cars.com/shopping/results/?year_min=2014&year_max=2015&makes%5B%5D=toyota&models%5B%5D=toyota-corolla&zip=76177";
  assert.ok(isListingSiteUrl(url));
  const q = listingSearchQueryFromUrl(url);
  assert.match(q, /corolla/i);
  assert.match(q, /76177|Fort Worth/i);

  const fetchPrompt = buildFetchSynthesisPrompt("check listings", {
    page: {
      url: "https://www.autotrader.com/cars-for-sale/toyota/corolla",
      title: "Corolla for Sale",
      listingSite: true,
      listings: [{ year: "2012", title: "2012 Toyota Corolla LE", price: "$7500", mileage: "110000" }],
      text: "LISTING CANDIDATES"
    },
    errors: []
  });
  assert.match(fetchPrompt, /VEHICLE LISTING|vehicles for sale|LISTING/i);
  assert.match(fetchPrompt, /NEVER pivot|trim\/package|Make it Mine/i);
  assert.match(fetchPrompt, /API-key|\.env/i);
}



// --- Generic vehicle locate (any make/model, not Corolla-only) ---
{
  const { extractVehicleListingSpec, buildVehicleListingQueries, isPackBackedLocateAsk } = require("./researchLoop");
  const { isLocateRecommendedVehicleAsk } = require("./domain/gigVehicle");

  const civic = "Find a 2018 Honda Civic under $12k near Fort Worth";
  assert.strictEqual(isLocateRecommendedVehicleAsk(civic), true, "Civic locate should route as listing locate");
  assert.strictEqual(isPackBackedLocateAsk(civic), false, "Civic locate must not be pack-backed Corolla");
  assert.strictEqual(extractBudget(civic), 12000);
  const civicRw = rewriteSearchQuery(civic, { wantsRecommendation: false });
  assert.strictEqual(civicRw.budget, 12000);
  const civicJoined = civicRw.queries.join(" | ");
  assert.match(civicJoined, /Civic/i, "queries must mention Civic: " + civicJoined);
  assert.match(civicJoined, /2018/, "queries must mention 2018: " + civicJoined);
  assert.match(civicJoined, /under\s+12000|price under\s+12000/i, "Civic budget: " + civicJoined);
  assert.ok(!/Corolla/i.test(civicJoined), "Civic locate must NOT invent Corolla: " + civicJoined);
  assert.ok(!/2010-2015|2010\.\.2015/i.test(civicJoined), "Civic locate must NOT invent Corolla years: " + civicJoined);

  const f150 = "Locate a Ford F-150 under $15k";
  assert.strictEqual(isLocateRecommendedVehicleAsk(f150), true);
  assert.strictEqual(isPackBackedLocateAsk(f150), false);
  assert.strictEqual(extractBudget(f150), 15000);
  const fRw = rewriteSearchQuery(f150, {});
  const fJoined = fRw.queries.join(" | ");
  assert.match(fJoined, /F-150|F150/i, "queries must mention F-150: " + fJoined);
  assert.match(fJoined, /under\s+15000|price under\s+15000/i, "F-150 budget: " + fJoined);
  assert.ok(!/Corolla/i.test(fJoined), "F-150 locate must NOT invent Corolla: " + fJoined);

  const spec = extractVehicleListingSpec(civic);
  assert.strictEqual(spec.model, "Civic");
  assert.strictEqual(spec.make, "Honda");
  assert.strictEqual(spec.years, "2018");
  assert.strictEqual(spec.budget, 12000);
  const built = buildVehicleListingQueries(spec).join(" | ");
  assert.match(built, /Civic/i);
  assert.match(built, /12000/);

  const civicPrompt = buildSynthesisPrompt(civic, "search", { web: [{ title: "guide", url: "https://www.edmunds.com/honda/civic/", snippet: "average price" }], news: null, stocks: {}, weather: null, page: null, domainPack: null, errors: [] }, false);
  assert.match(civicPrompt, /LOCATE\/FIND LISTING bans|no listings exist/i);
  assert.ok(!/LOCKED:\s*Corolla/i.test(civicPrompt), "Civic listing synth must not LOCK Corolla years");
}



// --- Platform eligibility hard gate (Lyft/Uber age) — NOT pack-only ---
{
  const {
    isPlatformEligibilityAsk,
    ensureGigVehicleDomainRoute,
    shouldUseKnowledgeFirst
  } = require("./domain/gigVehicle");
  const { evaluateSelfVerify, collectToolTextBlob } = require("./researchLoop");

  const lyftQ = "What are the Lyft vehicle AGE rules for rides in Texas? How old can the car be?";
  assert.strictEqual(isPlatformEligibilityAsk(lyftQ), true, "Lyft age ask must detect eligibility");
  const raw = routeMessage(lyftQ);
  assert.strictEqual(raw.intent, "search", "Lyft age must route search, got " + JSON.stringify(raw));
  assert.ok(raw.payload.forceToolRefresh, "Lyft age must forceToolRefresh");
  const forced = ensureGigVehicleDomainRoute(lyftQ, raw, {});
  assert.ok(forced.payload.forceToolRefresh, "ensure must keep forceToolRefresh");
  assert.ok(!forced.payload.domainPackPreferred, "must not prefer pack-only for Lyft age");
  assert.strictEqual(shouldUseKnowledgeFirst(lyftQ, forced), false);
  const plan = planTools(forced, lyftQ);
  assert.ok(plan.some((s) => s.tool === "search"), "Lyft age plan must include search, got: " + describePlan(plan));
  assert.ok(!plan.every((s) => s.tool === "domain"), "Lyft age must not be pack-only");
  const joined = plan.filter((s) => s.tool === "search").map((s) => s.args.query).join(" | ");
  assert.match(joined, /Lyft/i, "search queries should mention Lyft: " + joined);
  assert.match(joined, /help\.lyft\.com|vehicle|model year|requirements/i, "should prefer official/requirements query: " + joined);

  const uberQ = "Uber Dallas Fort Worth vehicle requirements years — what's the age limit?";
  assert.strictEqual(isPlatformEligibilityAsk(uberQ), true);
  const uPlan = planTools(ensureGigVehicleDomainRoute(uberQ, routeMessage(uberQ), {}), uberQ);
  assert.ok(uPlan.some((s) => s.tool === "search"), "Uber age must search");
  assert.ok(!uPlan.every((s) => s.tool === "domain"));
}

// --- Self-verify: year claim without tool text → RETRY needed ---
{
  const { evaluateSelfVerify } = require("./researchLoop");
  const draft =
    "Per Lyft official policy, vehicles must be manufactured after 2010 (2011+). A 2010 Corolla is a 2011 model year. Uber requires 2012+ in DFW. Verified via Lyft official site https://help.lyft.com/fake.";
  const emptyBag = { web: [], news: null, page: null };
  const v1 = evaluateSelfVerify(draft, emptyBag);
  assert.strictEqual(v1.needed, true, "unsupported policy claims must need retry");
  assert.ok(v1.status === "RETRY" || !v1.ok);

  const supportedBag = {
    web: [
      {
        title: "Texas Driver Information - Lyft Help",
        link: "https://help.lyft.com/hc/en-us/articles/115013083628-Texas-Driver-Information",
        snippet: "Vehicles must be model year 2010 or newer. Requirements may vary by region."
      }
    ]
  };
  const goodDraft =
    "According to Lyft's Texas help page, the baseline is model year 2010 or newer; regions may differ. Cite: https://help.lyft.com/hc/en-us/articles/115013083628-Texas-Driver-Information";
  const v2 = evaluateSelfVerify(goodDraft, supportedBag);
  assert.strictEqual(v2.needed, false, "tool-backed 2010 claim should PASS, got " + JSON.stringify(v2));
  assert.strictEqual(v2.status, "PASS");
}

// --- Lesson memory written on correction / addLesson ---
{
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { createDurableMemory } = require("./durableMemory");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aipick-lesson-"));
  const mem = createDurableMemory(() => tmp);
  const learned = mem.learnFromUserMessage(
    "That's wrong — that's not what Lyft says. You invented the year cutoff."
  );
  assert.ok(
    learned.learned.includes("correction") || learned.learned.includes("lesson:platform-eligibility"),
    "user correction must be learned: " + JSON.stringify(learned)
  );
  const snap = mem.getSnapshot();
  assert.ok(Array.isArray(snap.lessons) && snap.lessons.length >= 1, "lessons array must gain an entry");
  const added = mem.addLesson(
    "Lyft/Uber vehicle age requires live official fetch; never invent year cutoffs.",
    "test"
  );
  assert.ok(added.added || snap.lessons.length >= 1);
  const suffix = mem.buildSystemSuffix();
  assert.match(suffix, /Durable lessons|never invent year cutoffs|platform vehicle age/i);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Pack still OK for TCO (not eligibility)
{
  const { shouldUseKnowledgeFirst, isPlatformEligibilityAsk } = require("./domain/gigVehicle");
  const tco = "Best car for DoorDash under $10000 looking at annual cost reliability";
  assert.strictEqual(isPlatformEligibilityAsk(tco), false);
  assert.strictEqual(
    shouldUseKnowledgeFirst(tco, { intent: "search", payload: { wantsRecommendation: true } }),
    true
  );
}


console.log("All research-loop tests passed.");
