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

## In progress

- Forecast intelligence (weekend / multi-day polish)
- Stronger risk and market-context analysis beyond the current report template

## Next

- Earnings impact analysis (when data sources allow — no new APIs in stabilize pass)
- Local search (businesses / Fort Worth)
- Routing polish (fewer false weather/stock matches)

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

- Forecast weather, Finnhub stocks, structured reports, comparison, search quality, basic recommendations, UI harden
