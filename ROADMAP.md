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
| UI stabilize (clear, safe chat, Ollama errors) | Done |
| Intent router (fewer false weather/stock matches) | Done |
| Default model qwen3:30b | Done |
| Forecast intelligence polish | In progress |
| Deeper earnings / market context | Next |
| Local search | Later |
| Vault picks tool | Later (optional) |
| aipickvault.com shopping integration | Out of scope for now |

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
- Multi-step tool use (search + news + synthesize planner)
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
