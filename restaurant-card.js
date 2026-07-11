/*  restaurant-card.js  — custom Lovelace card
 *  Restaurant list with live Google Places data.
 *  - Stores restaurants in a Home Assistant todo list (default: todo.restaurants)
 *  - Tap a restaurant: expands to show open/closed, today's + weekly hours,
 *    driving distance/time, rating, address
 *  - Buttons: Website, Google Maps (live busyness), Remove
 *  - "+" button: search Google Places and add restaurants
 *
 *  Config:
 *    type: custom:restaurant-card
 *    entity: todo.restaurants        # todo list that stores the restaurants
 *    api_key: YOUR_GOOGLE_KEY        # Places API (New) + Routes API enabled
 *    title: Restaurants              # optional
 *    origin:                         # optional, defaults to HA home coords
 *      latitude: 40.0
 *      longitude: -75.0
 */

(() => {
  const CACHE_PREFIX = "restaurant-card:v1:";
  const DETAILS_TTL = 15 * 60 * 1000;      // open/closed freshness: 15 min
  const ROUTE_TTL = 60 * 60 * 1000;        // driving time freshness: 60 min
  const PLACES_BASE = "https://places.googleapis.com/v1";
  const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

  const DETAIL_MASK = [
    "id", "displayName", "formattedAddress", "location", "rating",
    "userRatingCount", "websiteUri", "googleMapsUri", "businessStatus",
    "currentOpeningHours", "regularOpeningHours", "priceLevel",
    "nationalPhoneNumber",
  ].join(",");

  const cacheGet = (key, ttl) => {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const { t, data } = JSON.parse(raw);
      if (Date.now() - t > ttl) return null;
      return data;
    } catch (e) { return null; }
  };
  const cacheSet = (key, data) => {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
    } catch (e) { /* storage full — ignore */ }
  };

  const fmtTime = (iso) => {
    try {
      return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
        .format(new Date(iso));
    } catch (e) { return ""; }
  };

  const escapeHtml = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  class RestaurantCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._items = [];          // todo items [{uid, summary, meta}]
      this._details = {};        // placeId -> place details
      this._routes = {};         // placeId -> {meters, seconds}
      this._expanded = null;     // expanded placeId
      this._searchOpen = false;
      this._searchResults = null;
      this._searchBusy = false;
      this._error = null;
      this._lastTodoState = null;
      this._rendered = false;
    }

    setConfig(config) {
      if (!config.entity) throw new Error("restaurant-card: 'entity' (a todo list) is required");
      this._config = { title: "Restaurants", ...config };
    }

    static getStubConfig() {
      return { entity: "todo.restaurants", api_key: "" };
    }

    getCardSize() { return Math.max(3, this._items.length + 1); }

    set hass(hass) {
      this._hass = hass;
      const st = hass.states[this._config.entity];
      const stVal = st ? `${st.state}|${st.last_updated}` : "missing";
      if (stVal !== this._lastTodoState) {
        this._lastTodoState = stVal;
        this._loadItems();
      } else if (!this._rendered) {
        this._render();
      }
    }

    get _origin() {
      const o = this._config.origin;
      if (o && o.latitude != null) return { latitude: o.latitude, longitude: o.longitude };
      return {
        latitude: this._hass.config.latitude,
        longitude: this._hass.config.longitude,
      };
    }

    get _useMiles() {
      return (this._hass?.config?.unit_system?.length || "mi") === "mi";
    }

    /* ---------- data ---------- */

    async _loadItems() {
      try {
        const res = await this._hass.callWS({
          type: "todo/item/list",
          entity_id: this._config.entity,
        });
        this._items = (res.items || []).map((it) => {
          let meta = {};
          try { meta = JSON.parse(it.description || "{}"); } catch (e) { /* not ours */ }
          return { uid: it.uid, summary: it.summary, meta };
        }).filter((it) => it.meta.place_id);
        this._error = null;
      } catch (e) {
        this._error = `Could not read ${this._config.entity}: ${e.message || e}`;
        this._items = [];
      }
      this._render();
      this._refreshAll();
    }

    async _refreshAll() {
      if (!this._config.api_key) return;
      for (const it of this._items) {
        this._fetchDetails(it.meta.place_id);
        this._fetchRoute(it.meta.place_id, it.meta);
      }
    }

    async _fetchDetails(placeId, force = false) {
      if (this._details[placeId] && !force) return;
      const cached = force ? null : cacheGet("d:" + placeId, DETAILS_TTL);
      if (cached) {
        this._details[placeId] = cached;
        this._render();
        return;
      }
      try {
        const r = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
          headers: {
            "X-Goog-Api-Key": this._config.api_key,
            "X-Goog-FieldMask": DETAIL_MASK,
          },
        });
        if (!r.ok) throw new Error(`Places ${r.status}: ${(await r.text()).slice(0, 120)}`);
        const data = await r.json();
        this._details[placeId] = data;
        cacheSet("d:" + placeId, data);
        this._render();
      } catch (e) {
        this._details[placeId] = { _error: String(e.message || e) };
        this._render();
      }
    }

    async _fetchRoute(placeId, meta, force = false) {
      if (this._routes[placeId] && !force) return;
      if (meta.latitude == null) return;
      const cached = force ? null : cacheGet("r:" + placeId, ROUTE_TTL);
      if (cached) { this._routes[placeId] = cached; this._render(); return; }
      try {
        const r = await fetch(ROUTES_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": this._config.api_key,
            "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
          },
          body: JSON.stringify({
            origin: { location: { latLng: this._origin } },
            destination: { location: { latLng: { latitude: meta.latitude, longitude: meta.longitude } } },
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE",
          }),
        });
        if (!r.ok) throw new Error(`Routes ${r.status}`);
        const data = await r.json();
        const route = (data.routes || [])[0];
        if (route) {
          const out = {
            meters: route.distanceMeters,
            seconds: parseInt(String(route.duration).replace("s", ""), 10),
          };
          this._routes[placeId] = out;
          cacheSet("r:" + placeId, out);
          this._render();
        }
      } catch (e) { /* distance is non-critical */ }
    }

    async _search(query) {
      this._searchBusy = true;
      this._render();
      try {
        const r = await fetch(`${PLACES_BASE}/places:searchText`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": this._config.api_key,
            "X-Goog-FieldMask":
              "places.id,places.displayName,places.formattedAddress,places.location",
          },
          body: JSON.stringify({
            textQuery: query,
            locationBias: { circle: { center: this._origin, radius: 40000 } },
          }),
        });
        if (!r.ok) throw new Error(`Search failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
        const data = await r.json();
        this._searchResults = (data.places || []).slice(0, 6);
        this._error = null;
      } catch (e) {
        this._error = String(e.message || e);
        this._searchResults = [];
      }
      this._searchBusy = false;
      this._render();
    }

    async _addPlace(place) {
      const meta = {
        place_id: place.id,
        address: place.formattedAddress,
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
      };
      await this._hass.callService("todo", "add_item", {
        entity_id: this._config.entity,
        item: place.displayName?.text || "Restaurant",
        description: JSON.stringify(meta),
      });
      this._searchOpen = false;
      this._searchResults = null;
    }

    async _removePlace(item) {
      await this._hass.callService("todo", "remove_item", {
        entity_id: this._config.entity,
        item: item.uid,
      });
    }

    /* ---------- rendering ---------- */

    _statusChip(d) {
      if (!d) return `<span class="chip loading">…</span>`;
      if (d._error) return `<span class="chip closed" title="${escapeHtml(d._error)}">error</span>`;
      const cur = d.currentOpeningHours;
      if (!cur || cur.openNow == null) return `<span class="chip unknown">hours n/a</span>`;
      if (cur.openNow) {
        const closes = cur.nextCloseTime ? ` · closes ${fmtTime(cur.nextCloseTime)}` : "";
        return `<span class="chip open">Open${closes}</span>`;
      }
      const opens = cur.nextOpenTime ? ` · opens ${fmtTime(cur.nextOpenTime)}` : "";
      return `<span class="chip closed">Closed${opens}</span>`;
    }

    _distanceText(placeId) {
      const rt = this._routes[placeId];
      if (!rt) return "";
      const dist = this._useMiles
        ? `${(rt.meters / 1609.34).toFixed(1)} mi`
        : `${(rt.meters / 1000).toFixed(1)} km`;
      const mins = Math.round(rt.seconds / 60);
      return `${dist} · ${mins} min drive`;
    }

    _hoursHtml(d) {
      const days = d.currentOpeningHours?.weekdayDescriptions
        || d.regularOpeningHours?.weekdayDescriptions;
      if (!days) return `<div class="muted">No hours available</div>`;
      const todayIdx = (new Date().getDay() + 6) % 7; // Mon=0
      return `<div class="hours">` + days.map((line, i) =>
        `<div class="${i === todayIdx ? "today" : ""}">${escapeHtml(line)}</div>`
      ).join("") + `</div>`;
    }

    _rowHtml(item) {
      const pid = item.meta.place_id;
      const d = this._details[pid];
      const expanded = this._expanded === pid;
      const dist = this._distanceText(pid);
      const rating = d?.rating
        ? `<span class="rating">★ ${d.rating}${d.userRatingCount ? ` (${d.userRatingCount})` : ""}</span>`
        : "";

      let detail = "";
      if (expanded) {
        const site = d?.websiteUri
          ? `<button class="btn primary" data-act="site" data-pid="${pid}">🌐 Website</button>` : "";
        const maps = d?.googleMapsUri
          ? `<button class="btn" data-act="maps" data-pid="${pid}">📍 Maps / busy times</button>` : "";
        detail = `
          <div class="detail">
            ${d && !d._error ? this._hoursHtml(d) : `<div class="muted">${escapeHtml(d?._error || "Loading…")}</div>`}
            <div class="muted addr">${escapeHtml(d?.formattedAddress || item.meta.address || "")}</div>
            <div class="actions">
              ${site}${maps}
              <button class="btn danger" data-act="remove" data-pid="${pid}">Remove</button>
            </div>
          </div>`;
      }

      return `
        <div class="row ${expanded ? "expanded" : ""}" data-pid="${pid}">
          <div class="rowmain" data-act="toggle" data-pid="${pid}">
            <div class="name">
              <span>${escapeHtml(item.summary)}</span>${rating}
            </div>
            <div class="sub">
              ${this._statusChip(d)}
              ${dist ? `<span class="dist">${dist}</span>` : ""}
            </div>
          </div>
          ${detail}
        </div>`;
    }

    _render() {
      if (!this._hass || !this._config) return;
      this._rendered = true;
      const noKey = !this._config.api_key;

      let search = "";
      if (this._searchOpen) {
        const results = (this._searchResults || []).map((p, i) => `
          <div class="result" data-act="pick" data-idx="${i}">
            <div class="rname">${escapeHtml(p.displayName?.text)}</div>
            <div class="muted">${escapeHtml(p.formattedAddress)}</div>
          </div>`).join("");
        search = `
          <div class="search">
            <div class="searchbar">
              <input id="q" type="text" placeholder="Search for a restaurant…" autocomplete="off"/>
              <button class="btn primary" data-act="dosearch">${this._searchBusy ? "…" : "Search"}</button>
            </div>
            ${this._searchResults ? `<div class="results">${results || `<div class="muted pad">No results</div>`}</div>` : ""}
          </div>`;
      }

      const rows = this._items.length
        ? this._items.map((it) => this._rowHtml(it)).join("")
        : `<div class="muted pad">No restaurants yet — tap ＋ to add one.</div>`;

      this.shadowRoot.innerHTML = `
        <style>
          ha-card { padding: 12px 16px 8px; }
          .head { display:flex; align-items:center; justify-content:space-between; }
          .title { font-size: 1.2em; font-weight: 500; }
          .addbtn { background: var(--primary-color); color: var(--text-primary-color, #fff);
            border:none; border-radius: 50%; width:32px; height:32px; font-size:20px;
            line-height:1; cursor:pointer; }
          .row { border-bottom: 1px solid var(--divider-color); padding: 10px 0; }
          .row:last-child { border-bottom: none; }
          .rowmain { cursor: pointer; }
          .name { font-weight: 500; display:flex; align-items:center; gap:8px; }
          .rating { color: var(--secondary-text-color); font-size: 0.85em; font-weight: 400; }
          .sub { display:flex; align-items:center; gap:10px; margin-top:4px; flex-wrap:wrap; }
          .chip { font-size: 0.8em; padding: 2px 10px; border-radius: 12px; }
          .chip.open { background: rgba(76,175,80,.18); color: #3d9142; }
          .chip.closed { background: rgba(244,67,54,.15); color: #e05a52; }
          .chip.unknown, .chip.loading { background: var(--secondary-background-color); color: var(--secondary-text-color); }
          .dist { font-size: 0.85em; color: var(--secondary-text-color); }
          .detail { margin-top: 8px; padding: 10px; border-radius: 8px;
            background: var(--secondary-background-color); }
          .hours { font-size: 0.85em; line-height: 1.6; color: var(--secondary-text-color); }
          .hours .today { color: var(--primary-text-color); font-weight: 600; }
          .addr { margin-top: 6px; font-size: 0.85em; }
          .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
          .btn { border:none; border-radius: 8px; padding: 8px 12px; cursor:pointer;
            background: var(--card-background-color); color: var(--primary-text-color);
            box-shadow: 0 1px 2px rgba(0,0,0,.2); font-size: 0.9em; }
          .btn.primary { background: var(--primary-color); color: var(--text-primary-color,#fff); }
          .btn.danger { color: #e05a52; }
          .muted { color: var(--secondary-text-color); font-size: 0.9em; }
          .pad { padding: 14px 0; }
          .search { margin: 10px 0; }
          .searchbar { display:flex; gap:8px; }
          .searchbar input { flex:1; padding:8px 10px; border-radius:8px;
            border:1px solid var(--divider-color); background: var(--card-background-color);
            color: var(--primary-text-color); font-size: 0.95em; }
          .results { margin-top:6px; border:1px solid var(--divider-color); border-radius:8px; }
          .result { padding:8px 10px; cursor:pointer; border-bottom:1px solid var(--divider-color); }
          .result:hover { background: var(--secondary-background-color); }
          .result:last-child { border-bottom:none; }
          .rname { font-weight:500; }
          .err { color:#e05a52; font-size:0.85em; margin:6px 0; }
          .warn { background: rgba(255,152,0,.15); border-radius:8px; padding:8px 10px;
            font-size:0.85em; margin:8px 0; }
        </style>
        <ha-card>
          <div class="head">
            <div class="title">${escapeHtml(this._config.title)}</div>
            <button class="addbtn" data-act="opensearch" title="Add restaurant">＋</button>
          </div>
          ${noKey ? `<div class="warn">Set <code>api_key</code> in the card config to enable live data.</div>` : ""}
          ${this._error ? `<div class="err">${escapeHtml(this._error)}</div>` : ""}
          ${search}
          <div class="list">${rows}</div>
        </ha-card>`;

      this.shadowRoot.querySelectorAll("[data-act]").forEach((el) => {
        el.addEventListener("click", (ev) => this._onAction(ev));
      });
      const q = this.shadowRoot.getElementById("q");
      if (q) {
        q.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && q.value.trim()) this._search(q.value.trim());
        });
        if (this._searchOpen && !this._searchResults) q.focus();
      }
    }

    _onAction(ev) {
      ev.stopPropagation();
      const el = ev.currentTarget;
      const act = el.dataset.act;
      const pid = el.dataset.pid;
      if (act === "opensearch") {
        this._searchOpen = !this._searchOpen;
        this._searchResults = null;
        this._render();
      } else if (act === "dosearch") {
        const q = this.shadowRoot.getElementById("q");
        if (q && q.value.trim()) this._search(q.value.trim());
      } else if (act === "pick") {
        const place = this._searchResults[Number(el.dataset.idx)];
        if (place) this._addPlace(place);
      } else if (act === "toggle") {
        this._expanded = this._expanded === pid ? null : pid;
        if (this._expanded) {
          const item = this._items.find((i) => i.meta.place_id === pid);
          this._fetchDetails(pid);
          if (item) this._fetchRoute(pid, item.meta);
        }
        this._render();
      } else if (act === "site") {
        const d = this._details[pid];
        if (d?.websiteUri) window.open(d.websiteUri, "_blank");
      } else if (act === "maps") {
        const d = this._details[pid];
        if (d?.googleMapsUri) window.open(d.googleMapsUri, "_blank");
      } else if (act === "remove") {
        const item = this._items.find((i) => i.meta.place_id === pid);
        if (item && confirm(`Remove ${item.summary}?`)) this._removePlace(item);
      }
    }
  }

  if (!customElements.get("restaurant-card")) {
    customElements.define("restaurant-card", RestaurantCard);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "restaurant-card")) {
    window.customCards.push({
      type: "restaurant-card",
      name: "Restaurant Card",
      description: "Restaurant list with live Google Places data: open status, hours, driving distance, website & busyness links.",
    });
  }
  console.info("%c RESTAURANT-CARD %c v1.0.0 ", "background:#3d9142;color:#fff", "background:#555;color:#fff");
})();
