# AIPickVault Desktop Roadmap

Standalone research assistant (Electron + Ollama). Design Webber owns this repo going forward. Do **not** integrate aipickvault.com shopping in the near term; Vault picks may become a tool later once the assistant is smarter.

## Snapshot

| Area | Status |
|------|--------|
| Weather forecast upgrade | Done |
| Search quality phase 1 | Done |
| Stock aliases / direct tickers | Done |
| Finnhub stock quotes | Done |
| Structured stock reports phase 1 | Done |
| Stock + news fusion phase 1 | Done |
| Stock comparison | Done |
| Recommendation engine phase 1 | Done (basic) |
| Gig-vehicle specialist pack (knowledge-first) | Done |
| Factual refresh (recall/price → tools) | Done |
| Durable memory seed (platforms + van) | Done |
| UI stabilize (clear, safe chat, Ollama errors) | Done |
| Intent router (fewer false weather/stock matches) | Done |
| Default model qwen3:30b | Done |
| Forecast intelligence polish | In progress |
| Deeper earnings / market context | Next |
| Local search | Later |
| Vault picks tool | Later (optional) |
| aipickvault.com shopping integration | Out of scope for now |



## Specialist subject learning (gig / delivery vehicles)

Desktop is being fine-tuned as a **local specialist** for Blake's courier vehicle choice (sub-$10k used cars, annual cost / reliability, Fort Worth gig mix) — **not** by adding more SerpAPI steps as the main intelligence strategy.

### Path (current → grow → optional train)

1. **Domain pack (now):** `domain/gig-vehicle.md` + `domain/gigVehicle.js`
   - Injected knowledge-first into system/synth for gig/vehicle advice.
   - Covers TCO buckets, Prius gens/battery caveats (principles), Corolla/Civic/Accord, DFW heat/stop-go, cargo van vs car for food vs Roadie/Flex.
2. **Durable memory:** `memory.json` in Electron userData — platforms, cargo van, sub-$10k evaluation, location, preferences. Grows from real sessions via `learnFromUserMessage`.
3. **Knowledge-first vs verify-tools**
   - **General advice** (best car under budget, reliability rank, van vs car): answer from pack + memory; plan tool = `domain` (no multi-search blast).
   - **Verification** (recall, NHTSA, prices, listings, insurance quotes, challenging a prior pick): `needsFactualRefresh` → force `search` (+ news when useful). Anti-hallucination: never invent listings/prices/campaign IDs.
4. **Grow the brain from good sessions:** after strong answers Blake endorses, fold durable corrections/preferences into memory; periodically expand `gig-vehicle.md` with hardened heuristics (still no fake live facts).
5. **Optional later:** Ollama Modelfile system glue, or a small LoRA/adapter trained on curated Q&A from this pack + anonymized good sessions — only after the pack + memory loop is stable.

### De-emphasized

- "More web search steps" as the default way to sound smart on this subject.
- Inventing Alliance listings / NHTSA IDs when tools were skipped.


## Completed

### Weather

- Forecast endpoint (high/low + condition)
- Weather intent routing

### Search

- Query optimization without invented years
- Web + news validation
- SEARCH vs CHAT routing

### Stocks

- Finnhub live quotes (not Alpha Vantage)
- Company aliases (AAPL, MSFT, NVDA, …)
- Direct ticker support
- Structured report prompt (price, risk, outlook, catalysts)
- News-enhanced analysis
- `compare A vs B` comparison engine

### Recommendations

- Best / runner-up / avoid style fallback when search results are empty

### Intent routing

- Extracted `routeMessage()` in `router.js`
- Priority: stock_compare > stock > weather > news > search > chat
- Weather requires context (not bare high/low/rain)
- Tickers: 1-5 letters, $TICKER, aliases (Apple to AAPL); skip common words
- Chat fallback for identity / how-to without forcing a tool

## In progress

- Forecast intelligence (weekend / multi-day polish)
- Stronger risk and market-context analysis beyond the current report template

## Next

- Earnings impact analysis (when data sources allow — no new APIs in stabilize pass)
- Local search (businesses / Fort Worth)
- Streaming replies
- Conversation memory
- Multi-step tool use for **verification** (recalls/prices) — not the primary specialist brain
- Grow `domain/gig-vehicle.md` from endorsed sessions; optional Modelfile/LoRA later
- Optional xAI provider adapter behind askOllama

## Later / ideas

- Vault picks as an optional tool
- Saved conversations
- Multi-query deep research
- Source credibility scoring
- Shopping mode (explicitly deferred)

## Released

### v1.0 stable

- Identity, chat/search routing, weather/news/stock/search tools

### v1.1 (active)

- Forecast weather, Finnhub stocks, structured reports, comparison, search quality, basic recommendations, UI harden, intent router, qwen3:30b default, streaming, memory, multi-step research loop
