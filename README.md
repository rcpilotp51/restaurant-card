# Restaurant Card

A custom Lovelace card for Home Assistant that keeps a list of your favorite restaurants with **live Google data**: open/closed status, hours, driving distance & time, ratings, and one-tap links to the restaurant's website and Google Maps (for live busyness).

![Restaurant Card](https://raw.githubusercontent.com/rcpilotp51/restaurant-card/main/screenshot.png)

## Features

- ➕ Search Google Places and add restaurants right from the card
- 🟢 Open/Closed chip with next closing/opening time
- 🚗 Driving distance and time from your home (traffic-aware)
- ⭐ Google rating and review count
- 📅 Tap a restaurant to expand: full weekly hours (today highlighted) and address
- 🌐 Website button — tap through to menus, ordering, etc.
- 📍 Maps button — opens Google Maps, where live busyness is one tap away
- 🗑 Remove restaurants from the expanded view
- Restaurant list is stored in a Home Assistant **to-do list entity**, so it syncs across every device and dashboard
- API responses are cached in the browser (15 min for open status, 60 min for drive times) to keep API usage well inside Google's free tier

## Prerequisites

1. **A Google Maps Platform API key** with these two APIs enabled:
   - [Places API (New)](https://console.cloud.google.com/apis/library/places.googleapis.com)
   - [Routes API](https://console.cloud.google.com/apis/library/routes.googleapis.com)

   **Restrict the key** (strongly recommended, since it is visible in your dashboard config):
   - Application restrictions → *Websites* → add every origin you use to open Home Assistant, e.g.:
     - `http://homeassistant.local:8123/*`
     - `https://YOUR-INSTANCE.ui.nabu.casa/*` (if you use Home Assistant Cloud)
   - API restrictions → limit the key to *Places API (New)* and *Routes API*

2. **A to-do list entity** to store your restaurants. Easiest: Settings → Devices & Services → Add Integration → **Local To-do** → name it "Restaurants" (creates `todo.restaurants`).

## Installation

### HACS (recommended)

1. HACS → three-dot menu → **Custom repositories**
2. Add this repository URL, category **Dashboard**
3. Install **Restaurant Card**, then reload your browser

### Manual

1. Download `restaurant-card.js` from the latest release
2. Copy it to `/config/www/`
3. Settings → Dashboards → three-dot menu → Resources → Add `/local/restaurant-card.js` as a **JavaScript module**

## Configuration

```yaml
type: custom:restaurant-card
entity: todo.restaurants          # required — the to-do list that stores your restaurants
api_key: YOUR_GOOGLE_API_KEY      # required for live data
title: Restaurants                # optional
origin:                           # optional — defaults to your HA home coordinates
  latitude: 40.0
  longitude: -75.0
```

| Option | Required | Default | Description |
| ------ | -------- | ------- | ----------- |
| `entity` | yes | — | A `todo.*` entity that stores the restaurant list |
| `api_key` | yes | — | Google Maps Platform API key (Places API (New) + Routes API) |
| `title` | no | `Restaurants` | Card title |
| `origin` | no | HA home coordinates | Origin for driving distance (`latitude`/`longitude`) |

## Usage

- Tap **＋** to search for a restaurant and tap a result to add it
- Tap a restaurant row to expand hours, address, and buttons
- **Website** opens the restaurant's site; **Maps / busy times** opens Google Maps
- **Remove** deletes it from the list

## Costs

Google's free monthly call caps comfortably cover personal use of this card (a handful of restaurants, browser-side caching). Check [Google Maps Platform pricing](https://mapsplatform.google.com/pricing/) for current free-tier limits.

## License

MIT
