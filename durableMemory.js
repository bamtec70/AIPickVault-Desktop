"use strict";

/**
 * Durable user-fact memory for AIPickVault Desktop.
 * Persists beyond the ~16-turn chat buffer to userData/memory.json.
 */

const fs = require("fs");
const path = require("path");

const MAX_FACTS = 40;
const MAX_CORRECTIONS = 20;
const MAX_PREFERENCES = 20;
const MAX_LESSONS = 40;

function defaultMemory() {
  return {
    version: 1,
    updatedAt: null,
    profile: {
      name: "Blake",
      location: "Fort Worth / Alliance (76177)",
      region: "Texas, US"
    },
    facts: [],
    preferences: [],
    corrections: [],
    lessons: [],
    work: {
      platforms: [],
      vehicleNotes: []
    }
  };
}

function createDurableMemory(getUserDataPath) {
  let cache = null;

  function memoryPath() {
    const base = typeof getUserDataPath === "function" ? getUserDataPath() : getUserDataPath;
    return path.join(String(base || "."), "memory.json");
  }

  function load() {
    if (cache) return cache;
    const file = memoryPath();
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        cache = { ...defaultMemory(), ...raw };
        cache.profile = { ...defaultMemory().profile, ...(raw.profile || {}) };
        cache.work = { ...defaultMemory().work, ...(raw.work || {}) };
        cache.facts = Array.isArray(raw.facts) ? raw.facts : [];
        cache.preferences = Array.isArray(raw.preferences) ? raw.preferences : [];
        cache.corrections = Array.isArray(raw.corrections) ? raw.corrections : [];
        cache.lessons = Array.isArray(raw.lessons) ? raw.lessons : [];
        return cache;
      }
    } catch (err) {
      console.error("durableMemory load error:", err && err.message ? err.message : err);
    }
    cache = defaultMemory();
    return cache;
  }

  function save() {
    const mem = load();
    mem.updatedAt = new Date().toISOString();
    const file = memoryPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(mem, null, 2), "utf8");
    } catch (err) {
      console.error("durableMemory save error:", err && err.message ? err.message : err);
    }
  }

  function uniqPush(arr, item, max) {
    const t = String(item || "").trim();
    if (!t) return;
    const lower = t.toLowerCase();
    const filtered = arr.filter((x) => String(x).toLowerCase() !== lower);
    filtered.push(t);
    while (filtered.length > max) filtered.shift();
    arr.length = 0;
    arr.push(...filtered);
  }

  /**
   * Extract durable facts from a user message (gig work, location, budget, vehicle, corrections).
   */
  function learnFromUserMessage(message) {
    const text = String(message || "").trim();
    if (!text) return { learned: [] };
    const lower = text.toLowerCase();
    const mem = load();
    const learned = [];

    // Platforms
    const platformMap = [
      [/\blyft\b/i, "Lyft"],
      [/doordash|door\s*dash/i, "DoorDash"],
      [/uber\s*eats/i, "Uber Eats"],
      [/\buber\b/i, "Uber"],
      [/roadie/i, "Roadie"],
      [/instacart/i, "Instacart"],
      [/grubhub/i, "Grubhub"],
      [/amazon\s+flex/i, "Amazon Flex"],
      [/\bshipt\b/i, "Shipt"]
    ];
    for (const [re, name] of platformMap) {
      if (re.test(text) && !mem.work.platforms.includes(name)) {
        mem.work.platforms.push(name);
        learned.push(`platform:${name}`);
      }
    }
    if (/\b(gig\s+delivery|last\s*mile|courier|delivery\s+driver)\b/i.test(text)) {
      uniqPush(mem.facts, "Works last-mile / gig delivery", MAX_FACTS);
      learned.push("fact:gig");
    }

    // Location
    if (/\b76177\b/.test(text) || /\balliance\b/i.test(text)) {
      mem.profile.location = "Fort Worth / Alliance (76177)";
      uniqPush(mem.facts, "Lives/works near Fort Worth Alliance (76177)", MAX_FACTS);
      learned.push("location:76177");
    } else if (/\bfort\s+worth\b/i.test(text)) {
      mem.profile.location = mem.profile.location || "Fort Worth, Texas";
      uniqPush(mem.facts, "Based in Fort Worth, Texas", MAX_FACTS);
      learned.push("location:ftw");
    }

    // Budget
    const budgetMatch =
      text.match(/under\s+\$?\s*([\d,]+)\s*k\b/i) ||
      text.match(/under\s+\$?\s*([\d,]+)/i) ||
      text.match(/\$\s*([\d,]+)\s*k\b/i) ||
      text.match(/\$\s*([\d,]{4,})/);
    if (budgetMatch && /\b(car|truck|suv|vehicle|budget)\b/i.test(text)) {
      let n = parseFloat(String(budgetMatch[1]).replace(/,/g, ""));
      if (/\bk\b/i.test(budgetMatch[0])) n *= 1000;
      if (n >= 100) {
        uniqPush(mem.preferences, `Used vehicle budget around under $${Math.round(n)}`, MAX_PREFERENCES);
        learned.push(`budget:${Math.round(n)}`);
      }
    }

    // Vehicle notes
    if (/\bcargo\s+van\b/i.test(text)) {
      uniqPush(mem.work.vehicleNotes, "Maintains a cargo van", MAX_FACTS);
      uniqPush(mem.facts, "Maintains a cargo van for delivery work", MAX_FACTS);
      learned.push("vehicle:cargo-van");
    }
    if (/\b(sub-?\$?10k|under\s+\$?10,?000|under\s+\$?10k)\b/i.test(text) && /\b(car|vehicle|sedan|hybrid|prius)\b/i.test(text)) {
      uniqPush(mem.work.vehicleNotes, "Also evaluating sub-$10k car for food/gig delivery", MAX_FACTS);
      learned.push("vehicle:sub10k");
    }
    if (/\b(prius|corolla|civic|camry|accord)\b/i.test(text)) {
      const m = text.match(/\b(prius|corolla|civic|camry|accord)\b/i);
      if (m) {
        uniqPush(mem.preferences, `Has mentioned ${m[1]}`, MAX_PREFERENCES);
        learned.push(`mention:${m[1]}`);
      }
    }

    // Criteria preferences
    if (/\b(annual\s+cost|cost\s+of\s+ownership|reliability|maintenance)\b/i.test(text)) {
      uniqPush(
        mem.preferences,
        "Cares about overall annual cost, reliability, and maintenance",
        MAX_PREFERENCES
      );
      learned.push("pref:tco");
    }

    // Corrections / dissatisfaction — remember so we don't repeat the failure mode
    const userCorrection =
      /\b(that was crap|that sucked|terrible answer|wrong|incorrect|inaccurate|useless|still crap|garbage answer|don't say|never say|stop saying|you invented|made that up|hallucinat|not what (?:lyft|uber|doordash) says|that'?s not what)\b/i.test(
        lower
      ) ||
      /\b(foreign import to avoid)\b/i.test(lower);
    if (userCorrection) {
      if (!Array.isArray(mem.lessons)) mem.lessons = [];
      if (!Array.isArray(mem.corrections)) mem.corrections = [];
      uniqPush(
        mem.corrections,
        text.length > 180 ? text.slice(0, 180) + "…" : text,
        MAX_CORRECTIONS
      );
      if (/foreign import/i.test(lower) || /hyundai|accent/i.test(lower)) {
        uniqPush(
          mem.corrections,
          "Do not label mainstream US-market cars as foreign imports to avoid",
          MAX_CORRECTIONS
        );
      }
      if (/no tool results|tool results do not/i.test(lower) || /crap|useless|terrible/i.test(lower)) {
        uniqPush(
          mem.corrections,
          "Never lead with tool-failure meta; lead with a direct recommendation",
          MAX_CORRECTIONS
        );
      }
      if (/lyft|uber|doordash|vehicle age|model year|invent/i.test(lower)) {
        uniqPush(
          mem.lessons,
          "User correction: platform vehicle age/eligibility requires live official fetch — never invent year cutoffs or help URLs.",
          MAX_LESSONS
        );
        learned.push("lesson:platform-eligibility");
      } else {
        uniqPush(
          mem.lessons,
          "User correction: " + (text.length > 160 ? text.slice(0, 160) + "…" : text),
          MAX_LESSONS
        );
        learned.push("lesson:user-correction");
      }
      learned.push("correction");
    }

    if (learned.length) save();
    return { learned };
  }

  function learnFromAssistantTurn(userMessage, assistantText) {
    // Hook for future reinforcement; keep lightweight for now.
    const lower = String(userMessage || "").toLowerCase();
    if (/\b(remember|don't forget|note that)\b/i.test(lower)) {
      const mem = load();
      uniqPush(mem.facts, String(userMessage).slice(0, 200), MAX_FACTS);
      save();
    }
    return assistantText;
  }

  function lessonsFilePath() {
    try {
      return path.join(__dirname, "domain", "lessons.md");
    } catch (_) {
      return null;
    }
  }

  function appendLessonToMarkdown(text, source) {
    const file = lessonsFilePath();
    if (!file) return;
    try {
      const line =
        "- (" + new Date().toISOString().slice(0, 10) + ") [" + (source || "runtime") + "] " +
        String(text || "").replace(/\s+/g, " ").trim() +
        "\n";
      let existing = "";
      try {
        existing = fs.readFileSync(file, "utf8");
      } catch (_) {
        existing =
          "# Durable lessons — AIPickVault Desktop\n\n" +
          "Append-only lessons so Desktop improves without external help.\n\n";
      }
      if (existing.toLowerCase().includes(String(text || "").toLowerCase().slice(0, 80))) return;
      fs.writeFileSync(file, existing.trimEnd() + "\n" + line, "utf8");
    } catch (err) {
      console.error("lessons.md append error:", err && err.message ? err.message : err);
    }
  }

  function addLesson(text, source) {
    const mem = load();
    if (!Array.isArray(mem.lessons)) mem.lessons = [];
    const t = String(text || "").trim();
    if (!t) return { added: false };
    const before = mem.lessons.slice();
    uniqPush(mem.lessons, t, MAX_LESSONS);
    const added = mem.lessons.join("|") !== before.join("|");
    if (added) {
      save();
      appendLessonToMarkdown(t, source || "self-verify");
    }
    return { added, lessons: mem.lessons.slice() };
  }

  function getLessons() {
    const mem = load();
    return Array.isArray(mem.lessons) ? mem.lessons.slice() : [];
  }

    function buildSystemSuffix() {
    const mem = load();
    const lines = [];
    lines.push("Known user context (durable memory — use it; do not make him re-explain):");
    if (mem.profile.name) lines.push(`- Name: ${mem.profile.name}`);
    if (mem.profile.location) lines.push(`- Location: ${mem.profile.location}`);
    if (mem.work.platforms && mem.work.platforms.length) {
      lines.push(`- Gig platforms: ${mem.work.platforms.join(", ")}`);
    }
    if (mem.work.vehicleNotes && mem.work.vehicleNotes.length) {
      for (const v of mem.work.vehicleNotes.slice(-5)) lines.push(`- Vehicle: ${v}`);
    }
    for (const f of (mem.facts || []).slice(-8)) lines.push(`- Fact: ${f}`);
    for (const p of (mem.preferences || []).slice(-6)) lines.push(`- Preference: ${p}`);
    if (mem.corrections && mem.corrections.length) {
      lines.push("Corrections / what NOT to do again:");
      for (const c of mem.corrections.slice(-6)) lines.push(`- ${c}`);
    }
    if (mem.lessons && mem.lessons.length) {
      lines.push("Durable lessons (self-verify / user corrections — obey these):");
      for (const L of mem.lessons.slice(-10)) lines.push(`- ${L}`);
    }
    lines.push(
      "Capability note: the facts above are context about Blake — they do NOT limit you to vehicle-only answers. You still handle weather, news, stocks, web search, webpage review, and general chat. Never claim you cannot view websites when a fetch tool/result is available."
    );
    if (lines.length <= 1) return "";
    return "\n\n" + lines.join("\n");
  }

  function ensureSeedProfile() {
    const mem = load();
    const added = [];
    const platforms = ["DoorDash", "Uber", "Uber Eats", "Roadie", "Amazon Flex", "Shipt"];
    for (const p of platforms) {
      if (!mem.work.platforms.includes(p)) {
        mem.work.platforms.push(p);
        added.push("platform:" + p);
      }
    }
    const beforeNotes = mem.work.vehicleNotes.slice();
    uniqPush(mem.work.vehicleNotes, "Maintains a cargo van", MAX_FACTS);
    uniqPush(mem.work.vehicleNotes, "Also evaluating sub-$10k car for food/gig delivery", MAX_FACTS);
    if (mem.work.vehicleNotes.join("|") !== beforeNotes.join("|")) added.push("vehicle:seed");
    mem.profile.location = "Fort Worth / Alliance (76177)";
    mem.profile.region = "Texas, US";
    mem.profile.name = mem.profile.name || "Blake";
    uniqPush(mem.facts, "Works last-mile / gig delivery", MAX_FACTS);
    uniqPush(mem.facts, "Lives/works near Fort Worth Alliance (76177)", MAX_FACTS);
    uniqPush(
      mem.preferences,
      "Cares about overall annual cost, reliability, and maintenance",
      MAX_PREFERENCES
    );
    uniqPush(
      mem.preferences,
      "Be honest about uncertainty; prefer sourced facts over guesses",
      MAX_PREFERENCES
    );
    uniqPush(mem.preferences, "Used vehicle budget around under $10000", MAX_PREFERENCES);
    if (added.length) save();
    return { added };
  }

  function reset() {
    cache = defaultMemory();
    save();
  }

  function getSnapshot() {
    return JSON.parse(JSON.stringify(load()));
  }

  return {
    load,
    save,
    learnFromUserMessage,
    learnFromAssistantTurn,
    addLesson,
    getLessons,
    appendLessonToMarkdown,
    buildSystemSuffix,
    ensureSeedProfile,
    reset,
    getSnapshot,
    memoryPath
  };
}

module.exports = { createDurableMemory, defaultMemory };
