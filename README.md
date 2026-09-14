# AIPickVault Desktop

AIPickVault Desktop is a standalone AI research assistant built by Blake Mauldin (Fort Worth, Texas).

It runs locally with Electron + Ollama. It is **not** integrated with aipickvault.com shopping yet.

## Features

- Local AI chat (Ollama models such as llama3 / qwen3-coder)
- Intelligent search (SerpAPI)
- Weather forecasts (WeatherAPI)
- News analysis (NewsAPI)
- Stock quotes + structured reports + compare (Finnhub)
- Recommendation-style answers when search data is thin

## Requirements

- Node.js
- [Ollama](https://ollama.com) running locally (`http://127.0.0.1:11434`)
- At least one pulled model, e.g. `ollama pull llama3`

## Setup

```bash
git clone https://github.com/bamtec70/AIPickVault-Desktop.git
cd AIPickVault-Desktop
npm install
```

Create a `.env` file in the project root (already gitignored):

```env
WEATHER_API_KEY=your_weatherapi_key
NEWS_API_KEY=your_newsapi_key
SEARCH_API_KEY=your_serpapi_key
FINNHUB_API_KEY=your_finnhub_key
```

## Run

```bash
npm start
```

## Technology Stack

- Electron
- Node.js
- Ollama (llama3 / qwen3-coder as configured in the UI)
- WeatherAPI
- NewsAPI
- Finnhub
- SerpAPI

## Current Status

Version: v1.1 development (standalone research assistant)

### Completed

- Weather forecast upgrade
- Search quality phase 1
- Stock symbol aliases + direct ticker support
- Finnhub stock quotes
- Stock + news fusion / structured stock reports (phase 1)
- Stock comparison (`compare SYMBOL vs SYMBOL`)
- Recommendation engine phase 1 (basic)

### In progress / next

- Deeper earnings / market-context analysis
- Forecast intelligence polish
- Local search
- Optional later: Vault picks as a tool (not shopping site integration yet)

## Roadmap

See `ROADMAP.md`.

## Author

Blake Mauldin  
Fort Worth, Texas

## License

MIT License
