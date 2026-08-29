// Bakeoff Arena — v2 SPA
// Views: Overview (leaderboard + equity + live feed), Models (drill-down),
// Symbols (cross-provider), Decisions (filterable feed). Reasoning drawer
// on decision click. 5-second poll on Overview + Decisions; on-demand for
// Models + Symbols to keep API load bounded.

const REFRESH_SECONDS = 5;

let config = null;
let chart = null;
let priceSeries = {};
let mode = "dollar";            // 'dollar' or 'pct'
let equityRange = "ALL";        // '1H' | '1D' | '1W' | 'ALL' — chart lookback window
let currentView = "overview";
let currentModel = null;
let pollTimer = null;

// 2026-08-28: Overview live feed filter (chip group above feed).
// "all" | "enters" | "exits" — filters d.decision or d.kind on the client.
let feedFilter = "all";

// 2026-08-28: date-range preset per view. When set to a preset, the raw
// date inputs are hidden; "custom" reveals them. Server sees since/until
// derived from the preset (or the raw inputs in custom mode).
const _dateRangeState = {
    model: { preset: "all", since: "", until: "" },
    decisions: { preset: "all", since: "", until: "" },
};

// Given a preset, compute {since, until} in YYYY-MM-DD (local date).
// "custom" returns the raw inputs untouched; "all" returns empty strings.
function _presetToDateRange(preset, rawSince, rawUntil) {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const toLocalISO = (d) => {
        // Local-time YYYY-MM-DD (avoids UTC-drift near midnight).
        const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    };
    if (preset === "custom") return { since: rawSince || "", until: rawUntil || "" };
    if (preset === "today") { const s = toLocalISO(today); return { since: s, until: s }; }
    if (preset === "yesterday") {
        const y = new Date(today); y.setDate(y.getDate() - 1);
        const s = toLocalISO(y); return { since: s, until: s };
    }
    if (preset === "7d") {
        const y = new Date(today); y.setDate(y.getDate() - 6);
        return { since: toLocalISO(y), until: toLocalISO(today) };
    }
    return { since: "", until: "" };  // "all"
}

// 2026-08-28: model-identity obfuscation. When on, every provider name in the
// dashboard is renamed to "Model N" (config-order index) so screen-shares
// don't reveal which vendor is which. Per-browser via localStorage; the
// operator's own machine stays revealed while a public tunnel-viewer sees
// only Model 1/2/3/...
let obfuscated = false;
const OBFUSCATED_BY_INTERNAL = {};   // internal name -> "Model N"
const OBFUSCATED_BY_DISPLAY = {};    // display name  -> "Model N"

function _buildObfuscationMap() {
    if (!config || !config.providers) return;
    config.providers.forEach((p, i) => {
        const label = `Model ${i + 1}`;
        OBFUSCATED_BY_INTERNAL[p.name] = label;
        OBFUSCATED_BY_DISPLAY[p.display_name] = label;
    });
}

// Return either the real model name or "Model N" depending on obfuscation
// state. Accepts EITHER the internal name (e.g. "gpt_oss_120b") or the
// display name (e.g. "gpt-oss-120b") — call sites use both.
function displayModel(name) {
    if (!obfuscated || !name) return name;
    return OBFUSCATED_BY_INTERNAL[name]
        || OBFUSCATED_BY_DISPLAY[name]
        || name;
}

// Strip vendor/model self-references from rationale text so an obfuscated
// dashboard can't accidentally leak identity via the LLM's own phrasing
// ("as Claude, I think..."). Redacts to [model]; deliberately aggressive
// — false positives cost readability, false negatives leak identity.
const MODEL_NAME_REGEX = /\b(anthropic|claude|deepseek|grok|gpt[- ]?oss|gpt[- ]?4[.-]?1[- ]?mini|gpt[- ]?4o|gpt|openai|xai|groq|qwen|kimi|mistral|llama|gemini)\b/gi;
function sanitizeRationale(text) {
    if (!obfuscated || !text) return text;
    return text.replace(MODEL_NAME_REGEX, "[model]");
}

// ============================================================================
// Init
// ============================================================================

async function init() {
    try {
        config = await fetchJson("/api/config");
    } catch (e) {
        document.body.innerHTML = `<div style="padding:40px;color:#ef4444;font-family:monospace">Failed to load config: ${e.message}</div>`;
        return;
    }
    document.getElementById("run-id").textContent = `${config.run_id} · BP $${fmt(config.buying_power, 0)}`;
    _buildObfuscationMap();
    // Restore obfuscation state before any render happens.
    try { obfuscated = localStorage.getItem("bakeoff_obfuscated") === "1"; }
    catch (e) { obfuscated = false; }  // Private-window / storage disabled.
    initChart();
    createSeries();
    populateModelSelector();
    populateProviderFilter();
    wireNav();
    wireToggles();
    wireModelSelector();
    wireModelDateFilter();
    wireFilters();
    wireDrawer();
    wireTradeChart();
    wireObfuscateToggle();
    wireKeyboard();
    // v14.19.23: in PUBLIC_MODE, obfuscation is baked into the JSON files.
    // Lock it ON at the client, hide the toggle, and hide the keyboard-hint
    // icon (kbd shortcuts still work — just no need to advertise them to
    // spectators).
    if (window.BAKEOFF_PUBLIC) {
        obfuscated = true;
        const b = document.getElementById("obfuscate-toggle"); if (b) b.style.display = "none";
        const k = document.querySelector(".kbd-hint"); if (k) k.style.display = "none";
    }
    _applyObfuscateButtonState();
    // v14.19.19: kick off market-context poll (SPY/QQQ/IWM). 60s cadence
    // to match server-side cache; failures are silent (icon shows —).
    _refreshMarketContext();
    setInterval(_refreshMarketContext, 60_000);
    showView("overview");
    await refreshCurrentView();
}

async function _refreshMarketContext() {
    try {
        const d = await fetchJson("/api/market_context");
        const tickers = (d && d.tickers) || [];
        tickers.forEach(t => {
            const el = document.querySelector(`.mc-slot[data-sym="${t.symbol}"]`);
            if (!el) return;
            if (t.last == null || t.change_pct == null) {
                el.textContent = `${t.symbol} —`;
                el.className = "mc-slot";
                return;
            }
            const sign = t.change_pct >= 0 ? "+" : "";
            el.innerHTML = `${t.symbol} <b>${sign}${t.change_pct.toFixed(2)}%</b>`;
            el.className = "mc-slot " + (t.change_pct >= 0 ? "pnl-pos" : "pnl-neg");
        });
        const stale = document.getElementById("mc-stale");
        if (stale && d.error) stale.textContent = "· error: " + d.error;
        else if (stale) stale.textContent = "";
    } catch (e) {
        /* silent — the bar just won't update this tick */
    }
}

function wireObfuscateToggle() {
    const btn = document.getElementById("obfuscate-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
        obfuscated = !obfuscated;
        try { localStorage.setItem("bakeoff_obfuscated", obfuscated ? "1" : "0"); }
        catch (e) { /* private window — session-only */ }
        _applyObfuscateButtonState();
        _applyObfuscationToChartSeries();
        populateModelSelector();          // re-label dropdown options
        populateProviderFilter();
        refreshCurrentView();             // re-render everything
    });
}

function _applyObfuscateButtonState() {
    const btn = document.getElementById("obfuscate-toggle");
    if (!btn) return;
    btn.textContent = obfuscated ? "🙈" : "👁";
    btn.title = obfuscated
        ? "Model identities HIDDEN — click to reveal"
        : "Click to hide model identities (Model 1, Model 2, …)";
    btn.classList.toggle("obfuscate-on", obfuscated);
}

// Lightweight Charts allows in-place title update via applyOptions.
function _applyObfuscationToChartSeries() {
    if (!config || !config.providers) return;
    for (const p of config.providers) {
        const s = priceSeries[p.name];
        if (s && s.applyOptions) {
            s.applyOptions({ title: displayModel(p.display_name) });
        }
    }
}

function initChart() {
    const container = document.getElementById("equity-chart");
    // Convert TradingView's Time value to a unix seconds number regardless of
    // whether it arrives as a UTCTimestamp (number) or a BusinessDay object
    // ({year, month, day}). Returning undefined from the formatter blanks the
    // axis (user reported "time missing from chart"); defensive typing prevents
    // that.
    const toUnix = (time) => {
        if (typeof time === "number") return time;
        if (time && typeof time === "object" && "year" in time) {
            return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
        }
        return null;
    };
    // Format a unix timestamp in America/New_York (ET) — the market's timezone.
    const fmtTimeET = (time) => {
        const unix = toUnix(time);
        if (unix === null) return "";
        return new Date(unix * 1000).toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
    };
    const fmtDateTimeET = (time) => {
        const unix = toUnix(time);
        if (unix === null) return "";
        return new Date(unix * 1000).toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
        }) + " ET";
    };
    chart = LightweightCharts.createChart(container, {
        layout: { background: { color: "#111821" }, textColor: "#cbd5e1", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
        grid: { vertLines: { color: "#1f2a37", style: 1 }, horzLines: { color: "#1f2a37", style: 1 } },
        rightPriceScale: {
            borderColor: "#2a3948",
            autoScale: true,
            // 5% top/bottom padding — tighter than the initial 15% which
            // made the data band look compressed in the middle.
            // renderEquity() also uses series.update() for incremental
            // refreshes so the initial autoScale doesn't fight the user's
            // manual zoom on every dashboard poll.
            scaleMargins: { top: 0.05, bottom: 0.05 },
        },
        timeScale: {
            borderColor: "#2a3948",
            timeVisible: true,
            secondsVisible: false,
            // SHORT ET formatter for axis ticks — "14:30" fits easily.
            tickMarkFormatter: (time) => fmtTimeET(time) || "",
        },
        localization: {
            // Verbose ET+" ET" for crosshair tooltip only. NOT used for axis
            // because Lightweight Charts v4 does fall back to this if
            // tickMarkFormatter isn't set — earlier bug where axis was blank.
            timeFormatter: (unix) => fmtDateTimeET(unix),
        },
        crosshair: { mode: 0 },
    });
    // Chart-sizing bug 2026-08-25: window.resize + container.clientHeight
    // fired ONCE at initChart before flex layout finished, so chart rendered
    // taller than its container. Parent panel's overflow:hidden then clipped
    // the bottom, cutting off both the price-scale lowest label AND the
    // entire time axis. Fix: ResizeObserver on the container watches for
    // ACTUAL size changes (including the initial flex layout) and rounds
    // dimensions down so chart never exceeds container.
    const resize = () => {
        const r = container.getBoundingClientRect();
        chart.applyOptions({
            width: Math.floor(r.width),
            height: Math.floor(r.height),
        });
    };
    if (window.ResizeObserver) {
        new ResizeObserver(resize).observe(container);
    } else {
        window.addEventListener("resize", resize);
    }
    resize();
    // NOTE: baseline reference at starting_capital is drawn per-series
    // via createPriceLine() after the first setData — see renderEquity().
}

function createSeries() {
    // 2026-08-28: v14.19.24 reverted the label suppression from v14.19.17.
    // The overlap of very-close values (Qwen $9,999.88 vs Claude $9,997.91)
    // is minor compared to LOSING series identity on the right axis — the
    // primary "which line is which" cue for most viewers. Right-side pills
    // now always show, matching what appears on private-mode toggle. The
    // top-left custom legend (v14.19.20) still exists for click-to-hide
    // AND shows the same values redundantly.
    for (const p of config.providers) {
        if (!p.enabled) continue;
        const s = chart.addLineSeries({
            color: p.color, lineWidth: 2,
            title: displayModel(p.display_name),
            priceLineVisible: false,
            lastValueVisible: true,
        });
        priceSeries[p.name] = s;
    }
    // v14.19.21: create hidden index-overlay series (SPY/QQQ/IWM) alongside
    // the model series. Dashed white-ish lines so they read as "benchmark"
    // rather than "just another model". Toggle from the chart legend.
    for (const idx of INDEX_OVERLAYS) {
        const s = chart.addLineSeries({
            color: idx.color, lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: "", priceLineVisible: false, lastValueVisible: false,
            visible: !!_indexEnabled[idx.symbol],
        });
        try { s.applyOptions({ title: "", lastValueVisible: false, priceLineVisible: false }); } catch (e) {}
        indexSeries[idx.symbol] = s;
    }
}

// v14.19.21: benchmark-index overlays. Normalized so a $starting_capital
// position on Day 1 open = current value at each bar. Rendered as dashed
// lines with muted colors so they visually read as "benchmark".
const INDEX_OVERLAYS = [
    { symbol: "SPY", label: "SPY (S&P 500)",  color: "#a1a1aa" },  // zinc-400
    { symbol: "QQQ", label: "QQQ (Nasdaq)",   color: "#d4d4d8" },  // zinc-300
    { symbol: "IWM", label: "IWM (Russell)",  color: "#71717a" },  // zinc-500
];
const indexSeries = {};   // symbol -> Lightweight Charts series
let _indexEnabled = {};   // symbol -> bool (persisted in localStorage)
const _indexDataCache = {};  // symbol -> [{time, value}, ...]

// Restore per-viewer index-overlay selection.
try {
    const saved = JSON.parse(localStorage.getItem("bakeoff_index_overlays") || "{}");
    if (saved && typeof saved === "object") _indexEnabled = saved;
} catch (e) { /* private-window */ }

async function _fetchIndexSeries(symbol) {
    if (_indexDataCache[symbol]) return _indexDataCache[symbol];
    try {
        const d = await fetchJson(`/api/index_series?symbol=${encodeURIComponent(symbol)}`);
        _indexDataCache[symbol] = (d && d.series) || [];
        return _indexDataCache[symbol];
    } catch (e) {
        console.warn(`[index] ${symbol} fetch failed`, e);
        return [];
    }
}

async function _toggleIndex(symbol) {
    const on = !_indexEnabled[symbol];
    _indexEnabled[symbol] = on;
    try { localStorage.setItem("bakeoff_index_overlays", JSON.stringify(_indexEnabled)); } catch (e) {}
    const s = indexSeries[symbol];
    if (!s) return;
    if (on) {
        const data = await _fetchIndexSeries(symbol);
        if (data.length) {
            const rendered = mode === "pct"
                ? data.map(p => ({ time: p.time, value: ((p.value / config.starting_capital) - 1) * 100 }))
                : data;
            s.setData(rendered);
        }
        s.applyOptions({ visible: true });
    } else {
        s.applyOptions({ visible: false });
    }
    renderChartLegendOverlay(_lastEquitySeries || {});
}

// Legend overlay — one row per enabled provider, plus a divider and
// toggleable rows for benchmark indices (SPY/QQQ/IWM). Populated by
// renderEquity() after each refresh with the most recent equity value.
// Click any model row to hide/show the series; click any index row to
// toggle the benchmark overlay (fetch-on-demand).
function renderChartLegendOverlay(series) {
    _lastEquitySeries = series;
    const el = document.getElementById("chart-legend");
    if (!el || !config || !config.providers) return;
    const modelRows = [];
    for (const p of config.providers) {
        if (!p.enabled) continue;
        const pts = series[p.name] || [];
        const last = pts.length ? pts[pts.length - 1].value : null;
        const label = displayModel(p.display_name);
        const val = last != null
            ? (mode === "pct"
                ? fmtPct(((last / config.starting_capital) - 1) * 100, true)
                : money(last))
            : "—";
        const cls = _hiddenSeries[p.name] ? "legend-row hidden" : "legend-row";
        modelRows.push(
            `<div class="${cls}" data-kind="model" data-provider="${p.name}" title="Click to toggle visibility">
               <span class="legend-dot" style="background:${p.color}"></span>
               <span class="legend-label">${escapeHtml(label)}</span>
               <span class="legend-val">${val}</span>
             </div>`
        );
    }
    // v14.19.21: index-overlay rows. Cached values come from the series
    // data itself; if disabled, show a "+" affordance instead of a value.
    const indexRows = INDEX_OVERLAYS.map(idx => {
        const on = !!_indexEnabled[idx.symbol];
        const data = _indexDataCache[idx.symbol];
        let val = on && data && data.length
            ? (mode === "pct"
                ? fmtPct(((data[data.length - 1].value / config.starting_capital) - 1) * 100, true)
                : money(data[data.length - 1].value))
            : (on ? "…" : "+");
        const cls = on ? "legend-row legend-index" : "legend-row legend-index off";
        return `<div class="${cls}" data-kind="index" data-symbol="${idx.symbol}"
                       title="${on ? "Click to hide" : "Click to overlay this benchmark"}">
                  <span class="legend-dot" style="background:${idx.color};border:1px solid #666"></span>
                  <span class="legend-label">${escapeHtml(idx.label)}</span>
                  <span class="legend-val">${val}</span>
                </div>`;
    }).join("");
    el.innerHTML = modelRows.join("") + `<div class="legend-divider"></div>` + indexRows;
    el.querySelectorAll(".legend-row").forEach(row => {
        row.addEventListener("click", () => {
            const kind = row.dataset.kind;
            if (kind === "model") {
                const name = row.dataset.provider;
                _hiddenSeries[name] = !_hiddenSeries[name];
                const s = priceSeries[name];
                if (s && s.applyOptions) s.applyOptions({ visible: !_hiddenSeries[name] });
                row.classList.toggle("hidden", _hiddenSeries[name]);
            } else if (kind === "index") {
                _toggleIndex(row.dataset.symbol);
            }
        });
    });
}
const _hiddenSeries = {};   // provider name -> true when user has hidden it
let _lastEquitySeries = null;   // cache series so re-renders (e.g. toggles) work

function populateModelSelector() {
    const sel = document.getElementById("model-selector");
    // Rebuild from scratch so an obfuscation toggle re-labels existing options.
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const p of config.providers) {
        if (!p.enabled) continue;
        const o = document.createElement("option");
        o.value = p.name;
        o.textContent = displayModel(p.display_name);
        sel.appendChild(o);
    }
    if (sel.options.length && !currentModel) {
        currentModel = sel.options[0].value;
    }
    // Restore selection after rebuild.
    if (currentModel) sel.value = currentModel;
}

function populateProviderFilter() {
    const sel = document.getElementById("filter-provider");
    // Keep the "all providers" default option; rebuild the rest.
    const first = sel.firstElementChild;
    while (sel.lastChild && sel.lastChild !== first) sel.removeChild(sel.lastChild);
    for (const p of config.providers) {
        const o = document.createElement("option");
        o.value = p.name; o.textContent = displayModel(p.display_name);
        sel.appendChild(o);
    }
}

// ============================================================================
// View routing
// ============================================================================

function wireNav() {
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.addEventListener("click", () => showView(btn.dataset.view));
    });
}

// 2026-08-28: keyboard shortcuts. Kept small on purpose — power-user layer
// on top of an existing mouse UI. Ignored when the user is typing into
// an input/textarea/select so search boxes still work.
const _NAV_KEY_TO_VIEW = { "1": "overview", "2": "models", "3": "decisions" };
function wireKeyboard() {
    document.addEventListener("keydown", (e) => {
        const t = e.target;
        const tag = t && t.tagName;
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
        if (typing && e.key !== "Escape") return;
        // Esc closes drawer or trade chart (in that priority order).
        if (e.key === "Escape") {
            const drawer = document.getElementById("reasoning-drawer");
            if (drawer && !drawer.classList.contains("hidden")) { closeDrawer(); e.preventDefault(); return; }
            const chartState = document.getElementById("chart-state");
            if (chartState && chartState.style.display !== "none") {
                const closeBtn = document.getElementById("chart-close");
                if (closeBtn) closeBtn.click();
                e.preventDefault();
                return;
            }
            return;
        }
        // 1/2/3 = tab switching.
        if (_NAV_KEY_TO_VIEW[e.key]) { showView(_NAV_KEY_TO_VIEW[e.key]); e.preventDefault(); return; }
        // "/" focuses the primary search input on current view.
        if (e.key === "/") {
            const primary = document.getElementById(
                currentView === "decisions" ? "filter-symbol" : null
            );
            if (primary) { primary.focus(); primary.select(); e.preventDefault(); }
        }
    });
}

let _modelRestoreDone = false;

function showView(name) {
    currentView = name;
    // Reset the trade-chart-restore latch each time the user re-enters
    // Models (or leaves it) so the resume-last-chart flow re-fires.
    if (name !== "models") _modelRestoreDone = false;
    else _modelRestoreDone = false;
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
    document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
    document.getElementById(`view-${name}`).classList.remove("hidden");
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (name === "overview") {
        pollTimer = setInterval(() => refreshOverview(), REFRESH_SECONDS * 1000);
    } else if (name === "decisions") {
        pollTimer = setInterval(() => refreshDecisions(), REFRESH_SECONDS * 1000);
    }
    refreshCurrentView();
}

function refreshCurrentView() {
    if (currentView === "overview") return refreshOverview();
    if (currentView === "models") return refreshModel();
    if (currentView === "decisions") return refreshDecisions();
}

// ============================================================================
// OVERVIEW
// ============================================================================

async function refreshOverview() {
    // Isolate each render — one broken render mustn't blank the others.
    const safe = (label, fn) => { try { fn(); } catch (e) { console.error(`[overview] ${label} failed:`, e); } };
    let state, equity, decisions;
    try {
        [state, equity, decisions] = await Promise.all([
            fetchJson("/api/state"),
            fetchJson(`/api/equity?range=${encodeURIComponent(equityRange)}`),
            fetchJson("/api/decisions?limit=50"),
        ]);
    } catch (e) {
        console.error("[overview] fetch failed:", e);
        document.getElementById("refresh-info").textContent = "⚠ Fetch error";
        return;
    }
    safe("leaderboard", () => renderLeaderboard(state.leaderboard));
    safe("highLow",     () => renderHighLow(state.leaderboard));
    safe("feed",        () => {
        // Client-side chip filter — cheap and keeps the API query wide
        // so switching chips is instant (no round-trip).
        let filtered = decisions.decisions;
        if (feedFilter === "enters") filtered = filtered.filter(d => d.decision === "ENTER");
        else if (feedFilter === "exits") filtered = filtered.filter(d => ["CLOSE","FLIP_TO_LONG","FLIP_TO_SHORT"].includes(d.decision));
        renderFeed(filtered, "feed-overview");
    });
    safe("equity",      () => renderEquity(equity.series));
    document.getElementById("last-refresh").textContent = "Last refresh: " + new Date().toLocaleTimeString();
    document.getElementById("refresh-info").textContent = "";
}

// 2026-08-28: client-side column sort. Default is server order (equity desc).
// Click a column header to sort by that key; click again to toggle direction.
// null sortColumn = defer to server order.
let sortColumn = null;
let sortDir = "desc";

function _installHeaderSort() {
    const header = document.getElementById("leaderboard-header");
    if (!header || header.dataset.wired === "1") return;
    header.dataset.wired = "1";
    header.querySelectorAll("th[data-sort]").forEach(th => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
            const col = th.dataset.sort;
            if (sortColumn === col) {
                sortDir = sortDir === "desc" ? "asc" : "desc";
            } else {
                sortColumn = col;
                // Sensible defaults per column type: numerics desc, text asc.
                sortDir = (col === "display_name" || col === "halted") ? "asc" : "desc";
            }
            // Re-render immediately without waiting for the next poll.
            if (_lastLeaderboardRows) renderLeaderboard(_lastLeaderboardRows);
        });
    });
}

function _applySortIndicators() {
    // 2026-08-28: wrap the arrow in its own <span> so we can style it
    // lighter and separate from the column label. Prior version jammed
    // "▼" into textContent, which read as part of the header text and
    // even the regex-cleanup was fragile (had to scrub before rerender).
    const header = document.getElementById("leaderboard-header");
    if (!header) return;
    header.querySelectorAll("th[data-sort]").forEach(th => {
        // Cache the original label once so we can restore cleanly.
        if (!th.dataset.baseLabel) {
            th.dataset.baseLabel = th.textContent
                .replace(/[▲▼]\s*$/, "").trim();
        }
        const base = th.dataset.baseLabel;
        if (th.dataset.sort === sortColumn) {
            const arrow = sortDir === "desc" ? "▼" : "▲";
            th.innerHTML = `${escapeHtml(base)} <span class="sort-ind">${arrow}</span>`;
        } else {
            th.textContent = base;
        }
    });
}

function _sortedRows(rows) {
    if (!sortColumn) return rows;
    // "rank" is a virtual key = server order + 1. Sort by original index.
    if (sortColumn === "rank") {
        const withIdx = rows.map((r, i) => ({r, i}));
        withIdx.sort((a, b) => sortDir === "desc" ? b.i - a.i : a.i - b.i);
        return withIdx.map(x => x.r);
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
        const av = a[sortColumn], bv = b[sortColumn];
        // null/undefined sink to the bottom regardless of direction.
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "string" || typeof bv === "string") {
            const cmp = String(av).localeCompare(String(bv));
            return sortDir === "desc" ? -cmp : cmp;
        }
        return sortDir === "desc" ? bv - av : av - bv;
    });
    return sorted;
}

let _lastLeaderboardRows = null;

function renderLeaderboard(rows) {
    _installHeaderSort();
    _lastLeaderboardRows = rows;
    // 2026-08-28: annotate cost_per_trade BEFORE sort so users can sort
    // by it. Null when no closed trades (leaves it at the bottom).
    rows.forEach(r => {
        r.cost_per_trade = (r.n_trades_total > 0 && r.cost_total_usd != null)
            ? (r.cost_total_usd / r.n_trades_total)
            : null;
    });
    const tbody = document.getElementById("leaderboard-body");
    tbody.innerHTML = "";
    const displayRows = _sortedRows(rows);
    _applySortIndicators();
    displayRows.forEach((r, i) => {
        const rank = i + 1;
        const rankCls = rank <= 3 ? `rank-${rank}` : "";
        const tr = document.createElement("tr");
        // v4 taxonomy 2026-08-26: OB (Day) added after Model (locked at open,
        // = prior day close Equity); Equity moved to end (LIVE liquidation value
        // = OB + Real (Day) + Unreal).
        tr.innerHTML = `
            <td><span class="rank-badge ${rankCls}">${rank}</span></td>
            <td><span class="dot" style="background:${r.color}"></span>${displayModel(r.display_name)}</td>
            <td class="num">${money(r.ob_day)}</td>
            <td class="num" style="color:var(--text-dim)">${money(r.buying_power)}</td>
            <td class="num ${pcls(r.realized_pnl_day)}">${money(r.realized_pnl_day, true)}</td>
            <td class="num ${pcls(r.unrealized_pnl)}">${money(r.unrealized_pnl, true)}</td>
            <td class="num ${pcls(r.pnl_day)}">${money(r.pnl_day, true)}</td>
            <td class="num ${pcls(r.pnl_total)}">${money(r.pnl_total, true)}</td>
            <td class="num">${money(r.cost_day_usd)}</td>
            <td class="num">${money(r.cost_total_usd)}</td>
            <td class="num" title="Cost per closed trade — LLM spend efficiency">${r.cost_per_trade != null ? money(r.cost_per_trade) : "—"}</td>
            <td class="num ${pcls(r.net_pnl_day)}">${money(r.net_pnl_day, true)}</td>
            <td class="num">${r.n_trades_day}/${r.n_trades_total}</td>
            <td class="num">${(r.win_rate_day * 100).toFixed(0)}%</td>
            <td class="num">${r.n_open_positions}</td>
            <td class="num">${money(r.buying_power_used)}</td>
            <td class="num ${pcls(r.equity - config.starting_capital)}">${money(r.equity)}</td>
            <td class="${r.halted ? 'halt-yes' : 'halt-no'}">${r.halted ? '⛔ HALT' : 'OK'} <span class="drill-cue" title="Click to drill down">›</span></td>
        `;
        tr.title = "Click to drill down to this model";
        tr.addEventListener("click", () => { document.getElementById("model-selector").value = r.provider; currentModel = r.provider; showView("models"); });
        tbody.appendChild(tr);
    });
}

let _baselineDrawn = false;
// Track last-plotted point per series so incremental refreshes use .update()
// instead of .setData(). setData() forces autoscale reset (frustrating —
// user zoomed the y-axis, refresh wipes it). .update() just appends new
// points and preserves user's current view. Reset on mode-toggle only.
const _lastPointTime = {};
let _lastMode = null;

function renderEquity(series) {
    const modeChanged = _lastMode !== mode;
    _lastMode = mode;
    for (const [name, points] of Object.entries(series)) {
        const s = priceSeries[name];
        if (!s || !points.length) continue;
        const data = mode === "pct"
            ? points.map(p => ({ time: p.time, value: ((p.value / config.starting_capital) - 1) * 100 }))
            : points;
        const lastPlotted = _lastPointTime[name];
        if (modeChanged || lastPlotted == null) {
            // First render OR mode toggled — full setData (only time we accept
            // the autoscale reset).
            s.setData(data);
        } else {
            // Incremental: append only new points, preserves user's y-axis zoom.
            for (const pt of data) {
                if (pt.time > lastPlotted) s.update(pt);
            }
        }
        _lastPointTime[name] = data[data.length - 1].time;
    }
    if (!_baselineDrawn) {
        const anySeries = Object.values(priceSeries).find(s => s);
        if (anySeries) {
            const baseValue = mode === "pct" ? 0 : config.starting_capital;
            anySeries.createPriceLine({
                price: baseValue, color: "#64748b", lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true, title: "start",
            });
            _baselineDrawn = true;
        }
    }
    // Only autofit the TIME axis on first render; subsequent refreshes leave
    // the user's manual pan/zoom alone.
    if (modeChanged || Object.keys(_lastPointTime).length <= 1) {
        chart.timeScale().fitContent();
    }
    // v14.19.17: refresh the legend overlay with the latest per-series value.
    renderChartLegendOverlay(series);
    // v14.19.21: on first paint OR mode change, re-render any enabled index
    // overlays so their y-axis matches the current $/% mode.
    if (modeChanged || !_indexInitialLoadDone) {
        _indexInitialLoadDone = true;
        for (const idx of INDEX_OVERLAYS) {
            if (!_indexEnabled[idx.symbol]) continue;
            _fetchIndexSeries(idx.symbol).then(data => {
                if (!data.length || !indexSeries[idx.symbol]) return;
                const rendered = mode === "pct"
                    ? data.map(p => ({ time: p.time, value: ((p.value / config.starting_capital) - 1) * 100 }))
                    : data;
                indexSeries[idx.symbol].setData(rendered);
                indexSeries[idx.symbol].applyOptions({ visible: true });
                renderChartLegendOverlay(_lastEquitySeries || {});
            });
        }
    }
}
let _indexInitialLoadDone = false;

function renderHighLow(rows) {
    if (!rows.length) return;
    // 2026-08-28: compute max/min explicitly. Prior version assumed the
    // server sort order (rows[0] = highest, rows[last] = lowest), which
    // broke after v14.19.4's column-click sort — users could sort by
    // Trades and HIGHEST/LOWEST would show whoever traded most/least.
    let highest = rows[0], lowest = rows[0];
    for (const r of rows) {
        if (r.equity > highest.equity) highest = r;
        if (r.equity < lowest.equity) lowest = r;
    }
    // Also follow the $/% mode so this summary matches the chart.
    const hDelta = highest.equity - config.starting_capital;
    const lDelta = lowest.equity - config.starting_capital;
    const hLabel = mode === "pct"
        ? fmtPct((highest.equity / config.starting_capital - 1) * 100, true)
        : money(hDelta, true);
    const lLabel = mode === "pct"
        ? fmtPct((lowest.equity / config.starting_capital - 1) * 100, true)
        : money(lDelta, true);
    document.getElementById("highest").innerHTML = `${displayModel(highest.display_name)} <b>${hLabel}</b>`;
    document.getElementById("lowest").innerHTML = `${displayModel(lowest.display_name)} <b>${lLabel}</b>`;
}

// ============================================================================
// DECISION FEED (shared renderer, used by 4 places)
// ============================================================================

// 2026-08-28: per-container seen-decision cache so we can highlight newly-
// arrived rows with a brief flash. Not persisted — first render of a
// container = every row is "seen" (no cold-start firework storm).
const _feedSeenIds = {};
function renderFeed(decisions, containerId, opts) {
    opts = opts || {};
    const feed = document.getElementById(containerId);
    feed.innerHTML = "";
    if (!decisions || !decisions.length) {
        feed.innerHTML = `<div style="color:#64748b;padding:20px;text-align:center">No decisions yet</div>`;
        return;
    }
    const seen = _feedSeenIds[containerId];
    const isColdStart = !seen;
    if (isColdStart) _feedSeenIds[containerId] = new Set();
    const currentSeen = _feedSeenIds[containerId];
    const provColor = {};
    const provDisplay = {};
    for (const p of config.providers) { provColor[p.name] = p.color; provDisplay[p.name] = p.display_name; }
    decisions.forEach(d => {
        const el = document.createElement("div");
        // Fade-in only for genuinely NEW rows on hot refreshes. Prevents
        // the whole feed from strobing on first paint.
        const isNew = !isColdStart && !currentSeen.has(d.decision_id);
        el.className = "feed-row" + (isNew ? " feed-row-new" : "");
        currentSeen.add(d.decision_id);
        el.dataset.decisionId = d.decision_id;
        const decLabel = d.parsed_ok ? d.decision : "FAIL";
        const decCls = "dec-" + decLabel;
        const dirCls = d.direction === "LONG" ? "dir-LONG" : d.direction === "SHORT" ? "dir-SHORT" : "";
        const dirText = d.direction && d.direction !== "NONE" ? ` ${d.direction}` : "";
        // 2026-08-28: labels expanded so a non-author can read the row.
        // "kind" is entry|exit LLM prompt; "conf" is 0-1 model self-report;
        // "size" is % of buying power; latency now human-friendly seconds
        // above 1s (reasoning models genuinely run 30-120s).
        //
        // v14.19.20: in obfuscated mode, hide tokens AND latency. Both leak
        // vendor identity: token-in/out ratios differ per model (reasoning
        // vs non-reasoning), and latency ranges are pretty diagnostic
        // (Groq flex sub-1s, DeepSeek reasoning 30-120s, etc.). Cost
        // efficiency and decision info still visible.
        const kindLabel = d.kind === "entry" ? "ENTRY-LLM" : d.kind === "exit" ? "EXIT-LLM" : (d.kind || "");
        const confPart = d.confidence != null ? `conf ${d.confidence.toFixed(2)}` : "";
        const sizePart = d.size_pct ? `size ${d.size_pct.toFixed(1)}%` : "";
        const latPart = (!obfuscated && d.latency_ms) ? `latency ${fmtLatency(d.latency_ms)}` : "";
        const midParts = [kindLabel, confPart, sizePart, latPart].filter(Boolean).join(" · ");
        const tokensPart = obfuscated
            ? ""
            : `tokens ${d.tokens_in || 0} in / ${d.tokens_out || 0} out`;
        const ts = fmtDateTime(d.ts);
        // 2026-08-28: show a tiny "+N more" badge when truncated so readers
        // know the full text lives in the drawer (click row to open).
        const fullRat = d.rationale ? sanitizeRationale(d.rationale) : "";
        const truncRat = fullRat.slice(0, 220);
        const moreBadge = fullRat.length > 220
            ? ` <span class="more-badge" title="Full rationale in the reasoning drawer">+${fullRat.length - 220} more</span>`
            : "";
        const rationale = fullRat
            ? escapeHtml(truncRat) + (fullRat.length > 220 ? "…" : "") + moreBadge
            : (d.parse_error ? `<span style="color:#ef4444">${escapeHtml(sanitizeRationale(d.parse_error || '').slice(0,160))}</span>` : "");
        const provLabel = displayModel(provDisplay[d.provider] || d.provider);
        el.innerHTML = `
            <div class="feed-r1">
                <span><span class="dot" style="background:${provColor[d.provider] || '#888'}"></span>${provLabel} · <b>${d.symbol}</b> <span class="feed-decision ${decCls}">${decLabel}</span><span class="${dirCls}">${dirText}</span></span>
                <span style="color:var(--text-dim)">${ts}</span>
            </div>
            <div class="feed-r2">
                <span>${midParts}</span>
                <span>${tokensPart}</span>
            </div>
            <div class="feed-r3">${rationale}</div>
        `;
        el.addEventListener("click", () => openDrawer(d.decision_id));
        feed.appendChild(el);
    });
}

// ============================================================================
// MODEL DRILL-DOWN
// ============================================================================

function wireModelSelector() {
    document.getElementById("model-selector").addEventListener("change", (e) => {
        currentModel = e.target.value;
        refreshModel();
    });
}

async function refreshModel() {
    if (!currentModel) return;
    // Restore last-viewed trade chart (if any) on first paint per view
    // load. Guarded so subsequent polls don't reopen it after user closed.
    if (!_modelRestoreDone) {
        _modelRestoreDone = true;
        setTimeout(_maybeRestoreTradeChart, 200);  // let tables render first
    }
    // 2026-08-28: chip-preset date filter applies to BOTH the closed-trade
    // log AND the per-model decision feed. Open positions and stats are
    // unaffected (open positions = current state; stats = lifetime).
    const { since, until } = _activeDateRange("model");
    const dateQs = (since ? `&since=${encodeURIComponent(since)}` : "")
                 + (until ? `&until=${encodeURIComponent(until)}` : "");
    try {
        const [stats, trades, opens, feed] = await Promise.all([
            fetchJson(`/api/provider/${currentModel}/stats`),
            fetchJson(`/api/provider/${currentModel}/trades?limit=200${dateQs}`),
            fetchJson(`/api/provider/${currentModel}/open_positions`),
            fetchJson(`/api/decisions?provider=${currentModel}&limit=100${dateQs}`),
        ]);
        renderModelStats(stats);
        renderModelTrades(trades.trades);
        renderModelPositions(opens.open_positions);
        renderFeed(feed.decisions, "feed-model");
    } catch (e) { console.error("model refresh failed", e); }
}

function renderModelStats(s) {
    const el = document.getElementById("model-stats");
    // 2026-08-28: each stat card carries a title= tooltip with a plain-
    // English definition. Prior version was label-only and readers had
    // to know finance jargon to interpret each metric.
    const cards = [
        ["Total Trades", s.n_trades, "Closed trades (lifetime). Excludes still-open positions."],
        ["Win Rate", `${(s.win_rate * 100).toFixed(1)}%`, "Wins ÷ (Wins + Losses). Zero-P&L trades excluded."],
        ["Total P&L", moneyC(s.total_pnl), "Sum of realized P&L across all closed trades. Does NOT include LLM cost — see Leaderboard for cost-adjusted equity."],
        ["Avg Win", moneyC(s.avg_win), "Mean P&L of winning trades only. Compare to Avg Loss for risk/reward."],
        ["Avg Loss", moneyC(s.avg_loss), "Mean P&L of losing trades only (shown negative)."],
        ["Profit Factor", s.profit_factor != null ? s.profit_factor.toFixed(2) : "—", "Gross wins ÷ gross losses. >1 = net profitable. Industry rule of thumb: >1.5 healthy, >2.0 strong."],
        ["Expectancy", moneyC(s.expectancy), "Total P&L ÷ Trades. Expected $ per trade taken. Positive = model has an edge."],
        ["Max Drawdown", moneyC(s.max_drawdown), "Largest peak-to-trough equity decline. Approximates worst-case pain during the run."],
        ["Sharpe (per-trade)", s.sharpe != null ? s.sharpe.toFixed(2) : "—", "Mean(P&L) ÷ Stddev(P&L) per trade. Higher = more consistent. Small-sample caveat applies here."],
        ["Best Trade", moneyC(s.best_trade), "Single largest winning trade."],
        ["Worst Trade", moneyC(s.worst_trade), "Single largest losing trade."],
        ["Avg Hold (min)", s.avg_hold_minutes ? s.avg_hold_minutes.toFixed(1) : "—", "Mean minutes each closed trade was held (entry → exit)."],
    ];
    el.innerHTML = cards.map(([lbl, val, tip]) =>
        `<div class="stat-card" title="${escapeHtml(tip)}"><div class="stat-label">${lbl}</div><div class="stat-value">${val}</div></div>`
    ).join("");
}

function moneyC(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const cls = n > 0 ? "pnl-pos" : (n < 0 ? "pnl-neg" : "pnl-zero");
    return `<span class="${cls}">${money(n, true)}</span>`;
}

function renderModelTrades(rows) {
    const tbody = document.querySelector("#model-trades tbody");
    tbody.innerHTML = "";
    // colspan updated for the new leading chart-icon column.
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-dim);padding:20px">No closed trades yet</td></tr>`; return; }
    rows.forEach(r => {
        const tr = document.createElement("tr");
        const dcls = r.direction === "LONG" ? "dir-LONG" : "dir-SHORT";
        // Leading icon column signals "row is clickable → chart" —
        // industry-standard pattern (Superset, DBT dashboards, etc.)
        tr.innerHTML = `
            <td class="row-icon" title="View chart">📈</td>
            <td>${fmtDateTime(r.exit_ts)}</td>
            <td>${r.symbol}</td>
            <td class="${dcls}">${r.direction}</td>
            <td class="num">${r.shares}</td>
            <td class="num">${money(r.entry_price)}</td>
            <td class="num">${money(r.exit_price)}</td>
            <td title="${r.exit_reason}">${prettyReason(r.exit_reason, r.tp_trailing_pct)}</td>
            <td class="num ${pcls(r.pnl_dollars)}">${money(r.pnl_dollars, true)}</td>
            <td class="num ${pcls(r.pnl_pct)}">${r.pnl_pct.toFixed(2)}%</td>
            <td class="num">${(r.hold_seconds / 60).toFixed(1)}m</td>
        `;
        tr.dataset.fillId = r.shadow_fill_id;
        tr.dataset.symbol = r.symbol;
        tr.addEventListener("click", () => openTradeChart(r.shadow_fill_id, r.symbol));
        tbody.appendChild(tr);
    });
}

function renderModelPositions(rows) {
    const tbody = document.querySelector("#model-positions tbody");
    tbody.innerHTML = "";
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:20px">No open positions</td></tr>`; return; }
    rows.forEach(r => {
        const dcls = r.direction === "LONG" ? "dir-LONG" : "dir-SHORT";
        const tp = r.take_profit_price != null ? money(r.take_profit_price) : (r.take_profit_trailing_pct != null ? `trail ${r.take_profit_trailing_pct}%` : "—");
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td>${fmtDateTime(r.entry_ts)}</td>
            <td>${r.symbol}</td>
            <td class="${dcls}">${r.direction}</td>
            <td class="num">${r.shares}</td>
            <td class="num">${money(r.entry_price)}</td>
            <td class="num">${money(r.notional)}</td>
            <td class="num">${r.invalidation != null ? money(r.invalidation) : '—'}</td>
            <td class="num">${tp}</td>
        `;
        tr.dataset.fillId = r.shadow_fill_id;
        tr.dataset.symbol = r.symbol;
        tr.addEventListener("click", () => openTradeChart(r.shadow_fill_id, r.symbol));
        tbody.appendChild(tr);
    });
}

// ============================================================================
// TRADE CHART (2026-08-26)
// ============================================================================
let _tradeChart = null;
let _tradeChartSeries = null;
let _tradeChartFillId = null;
let _tradeChartTF = "1m";
let _tradeChartRange = "today";
let _currentTradeMeta = null;

// Human-friendly labels for exit reasons. Trade log rows carry
// take_profit_trailing_pct on the fill; when the reason is TP and a trailing
// pct exists, the TP was a trailing stop (moves with high-water mark) rather
// than a fixed price target. Very different mechanic — the trailing case can
// exit at $0 profit if price backs off far enough from the peak.
const EXIT_REASON_BASE = {
    "TP": "TP hit (fixed)",
    "STOP": "SL hit (mechanical)",
    "CLOSE": "LLM close",
    "FLIP": "LLM flip",
    "alert_bot_shutdown": "EOD close",
    "EOD": "EOD close",
};
const prettyReason = (reason, tpTrailingPct) => {
    if (reason === "TP" && tpTrailingPct != null) return `Trailing ${tpTrailingPct}% (mechanical)`;
    return EXIT_REASON_BASE[reason] || reason;
};

async function openTradeChart(fillId, symbol) {
    _tradeChartFillId = fillId;
    // 2026-08-28: remember last-viewed trade per model so switching tabs
    // and coming back restores the chart instead of dumping the user
    // back at the feed. Symbol stored alongside so we can reopen without
    // a table round-trip.
    try {
        if (currentModel) localStorage.setItem(
            `bakeoff_last_trade_${currentModel}`,
            JSON.stringify({ fillId, symbol, ts: Date.now() })
        );
    } catch (e) { /* private-window / storage disabled */ }
    // Toggle panel state
    document.getElementById("feed-state").style.display = "none";
    const cs = document.getElementById("chart-state");
    cs.style.display = "flex";
    // Highlight selected row across both tables
    document.querySelectorAll("#model-trades tbody tr.selected, #model-positions tbody tr.selected")
        .forEach(x => x.classList.remove("selected"));
    document.querySelectorAll(`tr[data-fill-id="${fillId}"]`).forEach(x => x.classList.add("selected"));
    document.getElementById("chart-sym-label").textContent = symbol;
    await loadTradeChart();
    await loadSymFeed(symbol);
}

function closeTradeChart() {
    document.getElementById("feed-state").style.display = "";
    document.getElementById("chart-state").style.display = "none";
    document.querySelectorAll("tr.selected").forEach(x => x.classList.remove("selected"));
    _tradeChartFillId = null;
    // User explicitly closed → forget the memory so the next Models
    // visit lands on the feed (not auto-reopens the chart).
    try {
        if (currentModel) localStorage.removeItem(`bakeoff_last_trade_${currentModel}`);
    } catch (e) { /* noop */ }
    document.getElementById("view-models").classList.remove("chart-expanded");
}

// 2026-08-28: on Models-view load, offer to resume last-viewed trade.
// Silent no-op if none saved or storage disabled.
function _maybeRestoreTradeChart() {
    if (!currentModel) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`bakeoff_last_trade_${currentModel}`) || "null"); }
    catch (e) { return; }
    if (!saved || !saved.fillId || !saved.symbol) return;
    // Reopen quietly.
    openTradeChart(saved.fillId, saved.symbol);
}

function toggleChartExpand() {
    document.getElementById("view-models").classList.toggle("chart-expanded");
    setTimeout(() => {
        if (_tradeChart) {
            const el = document.getElementById("trade-chart");
            const r = el.getBoundingClientRect();
            _tradeChart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
            _tradeChart.timeScale().fitContent();
        }
    }, 60);
}

async function loadTradeChart() {
    if (!_tradeChartFillId) return;
    let data;
    try {
        data = await fetchJson(`/api/trade/${_tradeChartFillId}/bars?tf=${_tradeChartTF}&range=${_tradeChartRange}`);
    } catch (e) {
        document.getElementById("chart-title").innerHTML = `<span style="color:var(--text-dim)">Failed to load: ${e.message || e}</span>`;
        return;
    }
    if (data.error) {
        document.getElementById("chart-title").innerHTML = `<span style="color:var(--text-dim)">Error: ${data.error}</span>`;
        return;
    }
    const t = data.trade;
    const sideCls = t.direction === "LONG" ? "dir-LONG" : "dir-SHORT";
    const openBadge = t.is_open ? `<span class="tag" style="border:1px solid #38bdf8;color:#38bdf8;padding:1px 6px;font-size:10px;letter-spacing:.1em;">OPEN</span>` : "";
    const meta = t.is_open
        ? `Entry ${money(t.entry_price)} · ${t.shares}sh`
        : `Entry ${money(t.entry_price)} · Exit ${money(t.exit_price)} · ${t.shares}sh · ${(t.hold_seconds/60).toFixed(1)}m`;
    const pnlHtml = t.pnl != null
        ? `<span class="${pcls(t.pnl)}" style="margin-left:8px">${money(t.pnl, true)} · ${t.pnl_pct.toFixed(2)}%</span>` : "";
    document.getElementById("chart-title").innerHTML =
        `<span style="font-size:14px;letter-spacing:.1em">${t.symbol}</span>
         <span class="${sideCls}" style="padding:1px 6px;border:1px solid;font-size:10px;letter-spacing:.1em">${t.direction}</span>
         ${openBadge}
         <span style="color:var(--text-dim);font-size:11px">${meta}</span>
         ${pnlHtml}`;
    document.getElementById("chart-slhint").innerHTML =
        `SL <span style="color:var(--red)">${t.sl != null ? money(t.sl) : '—'}</span> · TP <span style="color:var(--green)">${t.tp != null ? money(t.tp) : (t.tp_trailing_pct != null ? `trail ${t.tp_trailing_pct}%` : '—')}</span>`;

    const el = document.getElementById("trade-chart");
    if (!_tradeChart) {
        _tradeChart = LightweightCharts.createChart(el, {
            layout: { background: { color: "#111821" }, textColor: "#cbd5e1",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
            grid: { vertLines: { color: "#1f2a37" }, horzLines: { color: "#1f2a37" } },
            // 2026-08-28 v14.19.22: price scale on the LEFT (not right). All
            // recent price action — including the exit bars — sits on the
            // right of the chart. Keeping SL/ENTRY/EXIT/TP labels on the
            // right axis crowded that region and hid the exit itself.
            // Left-side axis gives the exit bars a clean canvas.
            rightPriceScale: { visible: false },
            leftPriceScale:  { visible: true, borderColor: "#2a3948", scaleMargins: { top:0.1, bottom:0.1 } },
            timeScale: { borderColor: "#2a3948", timeVisible: true, secondsVisible: false,
                tickMarkFormatter: (time) => {
                    const unix = typeof time === "number" ? time : Math.floor(Date.UTC(time.year, time.month-1, time.day)/1000);
                    return new Date(unix * 1000).toLocaleTimeString("en-US",
                        { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
                },
            },
            localization: {
                // Crosshair tooltip in ET
                timeFormatter: (time) => {
                    const unix = typeof time === "number" ? time : Math.floor(Date.UTC(time.year, time.month-1, time.day)/1000);
                    return new Date(unix * 1000).toLocaleString("en-US",
                        { timeZone: "America/New_York", year:"numeric", month:"2-digit", day:"2-digit",
                          hour:"2-digit", minute:"2-digit", second:"2-digit", hour12: false }) + " ET";
                },
            },
            crosshair: { mode: 0 },
        });
        const resize = () => {
            const r = el.getBoundingClientRect();
            _tradeChart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
        };
        new ResizeObserver(resize).observe(el);
        resize();
        _tradeChartSeries = _tradeChart.addCandlestickSeries({
            upColor:"#10b981", downColor:"#ef4444",
            borderUpColor:"#10b981", borderDownColor:"#ef4444",
            wickUpColor:"#10b981", wickDownColor:"#ef4444",
            // v14.19.22: bind series to the LEFT price scale so createPriceLine
            // labels (SL/ENTRY/EXIT/TP) render on the left axis, away from
            // the recent-price/exit region on the right.
            priceScaleId: "left",
            // Disable TradingView's default "last bar close" indicator —
            // for closed trades it shows the current market price, not the
            // exit price, and confused the operator (2026-08-26 AAXJ).
            // We show entry / SL / TP explicitly via createPriceLine below.
            priceLineVisible: false,
            lastValueVisible: false,
        });
    }
    // Reset markers + priceLines
    _tradeChartSeries.setMarkers([]);
    if (_tradeChartSeries._priceLines) {
        _tradeChartSeries._priceLines.forEach(pl => _tradeChartSeries.removePriceLine(pl));
    }
    _tradeChartSeries._priceLines = [];
    _tradeChartSeries.setData(data.bars);
    // Markers: entry ▲, exit ▼ (closed) or LIVE ● (open)
    const markers = [];
    if (data.bars.length) {
        // Order-flow convention: BUY = green ▲, SELL = red ▼.
        //   LONG:  entry = buy (green ▲ below), exit = sell (red ▼ above)
        //   SHORT: entry = sell short (red ▼ above), exit = buy to cover (green ▲ below)
        const isLong = t.direction === "LONG";
        markers.push({
            time: t.entry_ts,
            position: isLong ? "belowBar" : "aboveBar",
            color: isLong ? "#10b981" : "#ef4444",
            shape: isLong ? "arrowUp" : "arrowDown",
            text: `ENTRY ${money(t.entry_price)} · ${t.shares}sh`,
        });
        if (t.is_open) {
            const last = data.bars[data.bars.length - 1];
            markers.push({
                time: last.time, position: "inBar", color: "#38bdf8", shape: "circle",
                text: `LIVE ${money(last.close)}`,
            });
        } else {
            markers.push({
                time: t.exit_ts,
                position: isLong ? "aboveBar" : "belowBar",
                color: isLong ? "#ef4444" : "#10b981",
                shape: isLong ? "arrowDown" : "arrowUp",
                text: `EXIT ${money(t.exit_price)} · ${prettyReason(t.exit_reason, t.tp_trailing_pct)} · ${money(t.pnl, true)}`,
            });
        }
    }
    _tradeChartSeries.setMarkers(markers);
    // Stash trade metadata for the filtered feed
    _currentTradeMeta = t;
    // Price lines — v14.19.13 fix for SHORT-trade visual ambiguity.
    // Prior version drew ENTRY price line only; on a SHORT profit the
    // EXIT marker's floating label rendered near/above the entry price
    // line label on the right axis, so at a glance the trade LOOKED like
    // "bought at exit, sold at entry" instead of the truth "sold-short
    // at entry, covered at exit". Fix: draw BOTH entry AND exit price
    // lines with prices baked into the title so the right-axis label
    // reads "ENTRY LONG 11.96" or "ENTRY SHORT 11.96" and can never be
    // confused with the exit label. Colors: entry = neutral blue, exit
    // = green if P&L>0 else red (profit direction is now visible from
    // the color relationship alone).
    const dirTag = t.direction === "SHORT" ? "SHORT" : "LONG";
    _tradeChartSeries._priceLines.push(_tradeChartSeries.createPriceLine({
        price: t.entry_price, color: "#38bdf8", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
        title: `ENTRY ${dirTag} ${money(t.entry_price)}`,
    }));
    if (!t.is_open && t.exit_price != null) {
        const exitColor = (t.pnl != null && t.pnl >= 0) ? "#10b981" : "#ef4444";
        _tradeChartSeries._priceLines.push(_tradeChartSeries.createPriceLine({
            price: t.exit_price, color: exitColor, lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
            title: `EXIT ${money(t.exit_price)}`,
        }));
    }
    if (t.sl != null) _tradeChartSeries._priceLines.push(_tradeChartSeries.createPriceLine({
        price: t.sl, color: "#ef4444", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "SL",
    }));
    if (t.tp != null) _tradeChartSeries._priceLines.push(_tradeChartSeries.createPriceLine({
        price: t.tp, color: "#10b981", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "TP",
    }));
    _tradeChart.timeScale().fitContent();
}

function wireTradeChart() {
    const close = document.getElementById("chart-close");
    const expand = document.getElementById("chart-expand");
    if (close) close.addEventListener("click", closeTradeChart);
    if (expand) expand.addEventListener("click", toggleChartExpand);
    document.querySelectorAll(".chart-tf").forEach(b => b.addEventListener("click", () => {
        document.querySelectorAll(".chart-tf").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        _tradeChartTF = b.dataset.tf;
        if (_tradeChartFillId) loadTradeChart();
    }));
    document.querySelectorAll(".chart-range").forEach(b => b.addEventListener("click", () => {
        document.querySelectorAll(".chart-range").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        _tradeChartRange = b.dataset.range;
        if (_tradeChartFillId) loadTradeChart();
    }));
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && _tradeChartFillId != null && !document.querySelector(".drawer.open")) {
            closeTradeChart();
        }
    });
}

async function loadSymFeed(symbol) {
    const el = document.getElementById("chart-sym-feed");
    el.innerHTML = `<div style="padding:12px;color:var(--text-dim)">Loading ${displayModel(currentModel) || 'model'} · ${symbol} decisions…</div>`;
    let data;
    try {
        data = await fetchJson(`/api/symbol/${encodeURIComponent(symbol)}?limit=200`);
    } catch (e) {
        el.innerHTML = `<div style="padding:12px;color:var(--red)">Failed: ${e.message || e}</div>`;
        return;
    }
    // Filter to only the currently-selected model. Cross-provider view lives
    // on the SYMBOLS tab; this filtered feed is for THIS model on THIS symbol.
    const allRows = data.decisions || [];
    const rows = currentModel ? allRows.filter(d => d.provider === currentModel) : allRows;
    if (!rows.length) { el.innerHTML = `<div style="padding:12px;color:var(--text-dim)">No decisions for ${displayModel(currentModel) || 'this model'} on ${symbol}</div>`; return; }
    // Build local prov lookup — provColor/provDisplay in renderFeed are function-scoped
    const _pc = {}, _pd = {};
    for (const p of config.providers) { _pc[p.name] = p.color; _pd[p.name] = p.display_name; }

    const renderRow = (d) => {
        const dCls = d.decision || "FAIL";
        const dir = d.direction && d.direction !== "NONE" ? `<span class="${d.direction === 'LONG' ? 'dir-LONG' : 'dir-SHORT'}" style="font-size:10px">${d.direction}</span>` : "";
        const conf = d.confidence != null ? `conf ${d.confidence.toFixed(2)}` : "";
        const rat = sanitizeRationale(d.rationale || d.parse_error || "").slice(0, 180);
        const dot = _pc[d.provider] || "#888";
        const provName = displayModel(_pd[d.provider] || d.provider);
        return `<div class="feed-item compact" data-decision-id="${d.decision_id}">
            <div class="feed-r1">
                <span class="dot" style="background:${dot}"></span>
                <span><b>${provName}</b> <span class="feed-decision dec-${dCls}">${dCls}</span> ${dir}</span>
                <span style="color:var(--text-dim);margin-left:auto">${fmtDateTime(d.ts)} · ${d.kind || ''} · ${conf}</span>
            </div>
            <div class="feed-r3">${rat}</div>
        </div>`;
    };

    // 2026-08-26: scope to THIS trade's lifetime + inject a mechanical-exit
    // pseudo-row when the exit reason is TP/STOP/EOD (no LLM decision fired
    // for that exit — the system triggered it).
    const meta = _currentTradeMeta;
    const entryDecId = meta ? meta.entry_decision_id : null;

    // Lifetime window via STRING comparison on ISO timestamps. All ts fields
    // are naive server-local (ET) ISO strings. Lexicographic comparison works
    // for same-timezone ISO strings and is TZ-safe unlike `new Date(iso)`
    // which reinterprets naive strings using the BROWSER's timezone (2026-08-26
    // bug: browsers on UTC while server is ET dropped every exit decision).
    // Tolerance: extend the exit boundary by ~2 minutes to catch the LLM
    // CLOSE decision that TRIGGERED the exit (typically stamped a few
    // hundred ms after the exit record).
    const entryTsIso = meta ? meta.entry_ts_iso : null;
    const exitTsIso = meta ? meta.exit_ts_iso : null;
    const exitTsPlusTolerance = (() => {
        if (!exitTsIso) return null;
        // Strip fractional seconds, parse as naive, add 120s, re-format.
        const base = exitTsIso.replace(/\.\d+$/, "");
        // Convert to a Date treating string as UTC (arbitrary — we only use
        // it for arithmetic then reformat). Add 120s, format YYYY-MM-DDTHH:MM:SS.
        const d = new Date(base + "Z");
        const shifted = new Date(d.getTime() + 120_000);
        return shifted.toISOString().slice(0, 19);
    })();
    const inLifetime = (d) => {
        if (entryTsIso && d.ts < entryTsIso) return false;
        if (exitTsPlusTolerance && d.ts > exitTsPlusTolerance) return false;
        return true;
    };

    const thisTradeEntry = entryDecId
        ? rows.filter(d => d.decision_id === entryDecId)
        : rows.filter(d => d.kind === "entry" && inLifetime(d));
    const thisTradePolls = rows.filter(
        d => d.kind === "exit" && d.decision !== "HOLD" && inLifetime(d) && !thisTradeEntry.includes(d)
    );
    const thisTradeHolds = rows.filter(
        d => d.kind === "exit" && d.decision === "HOLD" && inLifetime(d)
    );

    // Everything NOT part of this trade (other historical decisions on this symbol)
    const thisTradeIds = new Set([
        ...thisTradeEntry.map(x => x.decision_id),
        ...thisTradePolls.map(x => x.decision_id),
        ...thisTradeHolds.map(x => x.decision_id),
    ]);
    const otherDecisions = rows.filter(d => !thisTradeIds.has(d.decision_id));

    // Mechanical exit pseudo-row (only for closed trades with mechanical reason)
    const mechExitRow = (meta && !meta.is_open
        && meta.exit_reason && !["CLOSE", "FLIP"].includes(meta.exit_reason))
        ? `<div class="feed-item compact" style="opacity:.85; cursor:default;">
             <div class="feed-r1">
               <span class="dot" style="background:#94a3b8"></span>
               <span><b>SYSTEM</b> <span class="feed-decision" style="border:1px solid #94a3b8;color:#94a3b8;padding:1px 6px;font-size:10px;letter-spacing:.1em">${prettyReason(meta.exit_reason, meta.tp_trailing_pct)}</span></span>
               <span style="color:var(--text-dim);margin-left:auto">${fmtDateTime(meta.exit_ts)} · exit trigger</span>
             </div>
             <div class="feed-r3">Position closed at ${money(meta.exit_price)} — ${prettyReason(meta.exit_reason, meta.tp_trailing_pct)}. No LLM decision fired; watcher process hit the trigger.</div>
           </div>`
        : "";

    const section = (title, items, expandable = false, extraHtml = "") => {
        if (!items.length && !extraHtml) return "";
        const count = items.length + (extraHtml ? 1 : 0);
        const header = `<div style="padding:6px 12px; background:#0a1119; border-bottom:1px dashed var(--border);
            font-size:10px; letter-spacing:.15em; color:var(--text-dim);">${title} · ${count}</div>`;
        if (!expandable) return header + items.map(renderRow).join("") + extraHtml;
        return header + `<details><summary style="padding:8px 12px; color:var(--text-dim); cursor:pointer; font-size:11px;
            border-bottom:1px solid var(--border-dim);">show ${items.length} rows</summary>
            ${items.map(renderRow).join("")}</details>`;
    };

    el.innerHTML =
        section("THIS TRADE · ENTRY + EXIT", thisTradeEntry.concat(thisTradePolls), false, mechExitRow) +
        section("THIS TRADE · HOLD POLLS", thisTradeHolds, true) +
        section(`OTHER ${symbol} DECISIONS (past trades on same symbol)`, otherDecisions, true);
    // Wire click → drawer with full detail
    el.querySelectorAll(".feed-item[data-decision-id]").forEach(fi =>
        fi.addEventListener("click", () => openDrawer(parseInt(fi.dataset.decisionId, 10))));
}

// ============================================================================
// SYMBOL DRILL-DOWN
// ============================================================================

// ============================================================================
// DECISION FEED (filterable — full view)
// ============================================================================

function wireFilters() {
    document.getElementById("filter-apply").addEventListener("click", () => refreshDecisions());
    document.getElementById("filter-symbol").addEventListener("keyup", (e) => { if (e.key === "Enter") refreshDecisions(); });
    _wireDateChips("decisions", refreshDecisions);
    const clearBtn = document.getElementById("filter-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
        document.getElementById("filter-provider").value = "";
        document.getElementById("filter-symbol").value = "";
        document.getElementById("filter-decision").value = "";
        document.getElementById("filter-since").value = "";
        document.getElementById("filter-until").value = "";
        _selectDateChip("decisions", "all");
        refreshDecisions();
    });
    // Overview feed filter chip group.
    document.querySelectorAll("#feed-filter-chips .chip").forEach(btn => {
        btn.addEventListener("click", () => {
            feedFilter = btn.dataset.feedFilter;
            document.querySelectorAll("#feed-filter-chips .chip").forEach(
                b => b.classList.toggle("active", b === btn));
            refreshOverview();
        });
    });
}

// 2026-08-28: chip-preset wiring. `target` names a group in _dateRangeState.
// `onApply` fires after any chip click (or Apply within Custom).
function _wireDateChips(target, onApply) {
    const container = document.querySelector(`.date-chips[data-target="${target}"]`);
    if (!container) return;
    const chips = container.querySelectorAll(".chip[data-preset]");
    const customRange = container.querySelector(".custom-range");
    chips.forEach(btn => btn.addEventListener("click", () => {
        const preset = btn.dataset.preset;
        chips.forEach(b => b.classList.toggle("active", b === btn));
        _dateRangeState[target].preset = preset;
        if (customRange) customRange.classList.toggle("hidden", preset !== "custom");
        if (preset !== "custom") onApply();
    }));
    // The Apply button INSIDE custom-range re-triggers with the raw inputs.
    const customApply = container.querySelector(".custom-range .chip") || document.getElementById(`${target === "model" ? "model-filter-apply" : "filter-apply"}`);
    if (customApply) customApply.addEventListener("click", () => {
        _dateRangeState[target].since = container.querySelector('input[type="date"][id$="-since"]')?.value || "";
        _dateRangeState[target].until = container.querySelector('input[type="date"][id$="-until"]')?.value || "";
        onApply();
    });
}

function _selectDateChip(target, preset) {
    _dateRangeState[target].preset = preset;
    const container = document.querySelector(`.date-chips[data-target="${target}"]`);
    if (!container) return;
    container.querySelectorAll(".chip[data-preset]").forEach(
        b => b.classList.toggle("active", b.dataset.preset === preset));
    const customRange = container.querySelector(".custom-range");
    if (customRange) customRange.classList.toggle("hidden", preset !== "custom");
}

function _activeDateRange(target) {
    const st = _dateRangeState[target];
    return _presetToDateRange(st.preset, st.since, st.until);
}

async function refreshDecisions() {
    const provider = document.getElementById("filter-provider").value;
    const symbol = document.getElementById("filter-symbol").value.trim().toUpperCase();
    const decision = document.getElementById("filter-decision").value;
    const { since, until } = _activeDateRange("decisions");
    let url = "/api/decisions?limit=200";
    if (provider) url += `&provider=${encodeURIComponent(provider)}`;
    if (symbol) url += `&symbol=${encodeURIComponent(symbol)}`;
    if (decision) url += `&decision=${encodeURIComponent(decision)}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (until) url += `&until=${encodeURIComponent(until)}`;
    try {
        const data = await fetchJson(url);
        renderFeed(data.decisions, "feed-decisions");
        _renderActiveFilters({ provider, symbol, decision, since, until });
        const rangeNote = since || until ? ` · ${since || 'start'} → ${until || 'now'}` : "";
        document.getElementById("filter-count").textContent = `${data.decisions.length} decisions shown${rangeNote}`;
    } catch (e) { console.error("decisions refresh failed", e); }
}

// 2026-08-28: render active filters as removable chips above the feed.
// Each chip has an × that clears that ONE filter (unlike the global Clear
// button). Empty state hides the container entirely.
function _renderActiveFilters(state) {
    const el = document.getElementById("active-filters");
    if (!el) return;
    const chips = [];
    const addChip = (label, key) => chips.push({ label, key });
    if (state.provider) addChip(`Model: ${displayModel(state.provider)}`, "provider");
    if (state.symbol) addChip(`Symbol: ${state.symbol}`, "symbol");
    if (state.decision) addChip(`Decision: ${state.decision}`, "decision");
    if (state.since || state.until) addChip(`Range: ${state.since || 'start'} → ${state.until || 'now'}`, "range");
    if (!chips.length) { el.innerHTML = ""; return; }
    el.innerHTML = chips.map(c =>
        `<span class="filter-chip" data-remove="${c.key}">${escapeHtml(c.label)} <span class="filter-chip-x" title="Remove">×</span></span>`
    ).join("");
    el.querySelectorAll(".filter-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const key = chip.dataset.remove;
            if (key === "provider") document.getElementById("filter-provider").value = "";
            else if (key === "symbol") document.getElementById("filter-symbol").value = "";
            else if (key === "decision") document.getElementById("filter-decision").value = "";
            else if (key === "range") _selectDateChip("decisions", "all");
            refreshDecisions();
        });
    });
}

// 2026-08-28: MODELS tab date filter — chip presets (Today/Yesterday/7d/
// All/Custom). Applies to BOTH the closed-trade log AND the per-model
// decision feed on that view.
function wireModelDateFilter() {
    _wireDateChips("model", refreshModel);
}

// ============================================================================
// REASONING DRAWER
// ============================================================================

function wireDrawer() {
    document.getElementById("close-drawer").addEventListener("click", closeDrawer);
}

function openDrawer(decisionId) {
    if (!decisionId) return;
    const body = document.getElementById("drawer-body");
    body.innerHTML = `<div style="color:var(--text-dim)">Loading…</div>`;
    document.getElementById("reasoning-drawer").classList.remove("hidden");
    fetchJson(`/api/reasoning/${decisionId}`).then(d => {
        const ts = fmtDateTime(d.ts);
        const p = config.providers.find(x => x.name === d.provider);
        body.innerHTML = `
            <h4>Header</h4>
            <dl>
                <dt>Provider</dt><dd><span class="dot" style="background:${p?.color || '#888'}"></span>${displayModel(p?.display_name || d.provider)}</dd>
                <dt>Symbol</dt><dd>${d.symbol}</dd>
                <dt>Kind</dt><dd>${d.prompt_kind}</dd>
                <dt>Decision</dt><dd class="feed-decision dec-${d.decision || 'FAIL'}">${d.decision || 'PARSE FAIL'}</dd>
                <dt>Direction</dt><dd>${d.direction || '—'}</dd>
                <dt>Size %</dt><dd>${d.size_pct != null ? d.size_pct.toFixed(1) + '%' : '—'}</dd>
                <dt>Invalidation</dt><dd>${d.invalidation != null ? '$' + d.invalidation.toFixed(2) : '—'}</dd>
                <dt>Take Profit</dt><dd>${d.take_profit_price != null ? '$' + d.take_profit_price.toFixed(2) : (d.take_profit_trailing_pct != null ? 'trailing ' + d.take_profit_trailing_pct + '%' : '—')}</dd>
                <dt>Confidence</dt><dd>${d.confidence != null ? d.confidence.toFixed(2) : '—'}</dd>
                <dt>Timestamp</dt><dd>${ts}</dd>
                ${obfuscated ? "" : `<dt>Latency</dt><dd>${fmtLatency(d.latency_ms)}</dd>
                <dt>Tokens</dt><dd>${d.tokens_in || 0} in / ${d.tokens_out || 0} out</dd>`}
                <dt title="LLM cost attributed to THIS specific decision. Zero when the vendor didn't return usage or the row was written before per-decision cost tracking landed.">Cost</dt><dd>${d.cost_usd ? "$" + d.cost_usd.toFixed(4) : "—"}</dd>
            </dl>
            <div class="drawer-two-col">
                <div>
                    <h4>Rationale</h4>
                    <div class="rationale">${d.rationale ? escapeHtml(sanitizeRationale(d.rationale)) : (d.parse_error ? '<span style="color:#ef4444">PARSE FAILURE: ' + escapeHtml(sanitizeRationale(d.parse_error)) + '</span>' : '(none)')}</div>
                </div>
                <div>
                    <h4>Raw response <span style="opacity:.5;font-weight:normal;font-size:11px">(as returned by the model)</span></h4>
                    <pre class="raw">${escapeHtml(sanitizeRationale(d.raw_response || '(empty)'))}</pre>
                </div>
            </div>
        `;
    }).catch(e => {
        body.innerHTML = `<div style="color:#ef4444">Error: ${e.message}</div>`;
    });
}

function closeDrawer() {
    document.getElementById("reasoning-drawer").classList.add("hidden");
}

// ============================================================================
// Overview toggles
// ============================================================================

function wireToggles() {
    // 2026-08-28: two separate button groups now — $/% mode and equity time
    // range (1H/1D/1W/ALL). Split the handler so a range click doesn't set
    // mode=undefined.
    document.querySelectorAll(".toggle[data-mode]").forEach(btn => {
        btn.addEventListener("click", () => {
            mode = btn.dataset.mode;
            document.querySelectorAll(".toggle[data-mode]").forEach(
                b => b.classList.toggle("active", b === btn));
            refreshOverview();
        });
    });
    document.querySelectorAll(".toggle[data-range]").forEach(btn => {
        btn.addEventListener("click", () => {
            equityRange = btn.dataset.range;
            document.querySelectorAll(".toggle[data-range]").forEach(
                b => b.classList.toggle("active", b === btn));
            // Reset per-series bookkeeping so renderEquity() rebuilds with
            // setData() + fitContent() — the whole chart re-fits to the new
            // range instead of trying to incremental-update a different span.
            for (const k of Object.keys(_lastPointTime)) delete _lastPointTime[k];
            _lastMode = null;
            refreshOverview();
        });
    });
}

// ============================================================================
// Helpers
// ============================================================================

// v14.19.23: PUBLIC_MODE shim. When window.BAKEOFF_PUBLIC === true (set by
// the public index.html template written by publish_snapshot.py), every
// /api/* request is rewritten to fetch a pre-generated static JSON file
// from the ./data/ tree. Server-side filters (?limit=, ?symbol=, ?range=)
// become client-side filters since the static snapshots carry everything.
// This lets the SAME app.js run against both the live sidecar and the
// static GitHub-Pages public mirror without a forked codebase.
async function fetchJson(url) {
    if (window.BAKEOFF_PUBLIC) {
        return _fetchStatic(url);
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return await r.json();
}

async function _fetchStatic(url) {
    // Parse the URL to route to the right static file. Query params are
    // applied client-side on the returned payload.
    const [path, qs] = url.split("?");
    const params = new URLSearchParams(qs || "");
    let filePath = null;
    let postFilter = null;

    if (path === "/api/config") filePath = "data/config.json";
    else if (path === "/api/state") filePath = "data/state.json";
    else if (path === "/api/equity") {
        // v14.19.27: the public repo only ships one equity.json (range=ALL).
        // Apply the range filter client-side by keeping points whose time
        // is within the requested window OF THE LAST POINT (not of now — a
        // page loaded post-session should still see the trading day, not
        // an empty overnight window).
        filePath = "data/equity.json";
        const range = (params.get("range") || "").toUpperCase();
        const RANGE_SEC = { "1H": 3600, "1D": 24 * 3600, "1W": 7 * 24 * 3600 };
        const cutoff = RANGE_SEC[range];
        if (cutoff) {
            postFilter = (body) => {
                if (!body || !body.series) return body;
                const out = {};
                for (const [name, pts] of Object.entries(body.series)) {
                    if (!pts || !pts.length) { out[name] = pts || []; continue; }
                    const lastT = pts[pts.length - 1].time;
                    const start = lastT - cutoff;
                    out[name] = pts.filter(p => p.time >= start);
                }
                return { ...body, series: out };
            };
        }
    }
    else if (path === "/api/market_context") filePath = "data/market_context.json";
    else if (path === "/api/index_series") {
        const sym = (params.get("symbol") || "").toUpperCase();
        filePath = `data/index_series/${sym}.json`;
    }
    else if (path === "/api/decisions") {
        filePath = "data/decisions.json";
        postFilter = (body) => {
            let d = body.decisions || [];
            const p = params.get("provider");
            const s = params.get("symbol");
            const k = params.get("kind");
            const dec = params.get("decision");
            const since = params.get("since"), until = params.get("until");
            if (p) d = d.filter(r => r.provider === p);
            if (s) d = d.filter(r => (r.symbol || "").toUpperCase() === s.toUpperCase());
            if (k) d = d.filter(r => r.kind === k);
            if (dec) d = d.filter(r => r.decision === dec);
            if (since) d = d.filter(r => (r.ts || "").slice(0, 10) >= since);
            if (until) d = d.filter(r => (r.ts || "").slice(0, 10) <= until);
            const lim = parseInt(params.get("limit") || "100", 10);
            return { decisions: d.slice(0, lim) };
        };
    }
    else if (path.startsWith("/api/reasoning/")) {
        const id = path.split("/").pop();
        filePath = `data/reasoning/${id}.json`;
    }
    else if (path.startsWith("/api/trade/") && path.endsWith("/bars")) {
        const id = path.split("/")[3];
        filePath = `data/trades/${id}.json`;
    }
    else if (path.startsWith("/api/provider/")) {
        const parts = path.split("/");   // ["", "api", "provider", "<name>", "trades"|"open_positions"|"stats"]
        const name = parts[3], sub = parts[4];
        filePath = `data/model/${name}/${sub}.json`;
        if (sub === "trades") {
            postFilter = (body) => {
                let t = body.trades || [];
                const since = params.get("since"), until = params.get("until");
                if (since) t = t.filter(r => (r.exit_ts || "").slice(0, 10) >= since);
                if (until) t = t.filter(r => (r.exit_ts || "").slice(0, 10) <= until);
                return { ...body, trades: t };
            };
        }
    }

    if (!filePath) throw new Error(`PUBLIC_MODE: no static route for ${url}`);
    const r = await fetch(filePath, { cache: "no-store" });
    if (!r.ok) throw new Error(`${filePath}: ${r.status}`);
    const body = await r.json();
    return postFilter ? postFilter(body) : body;
}

function fmt(n, decimals) {
    if (n === null || n === undefined) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function money(n, sign) {
    if (n == null || Number.isNaN(n)) return "—";
    const s = sign && n >= 0 ? "+" : (n < 0 ? "-" : "");
    const abs = Math.abs(n);
    return `${s}$${fmt(abs, 2)}`;
}

function fmtPct(n, withSign) {
    if (n === null || n === undefined) return "—";
    const sign = withSign && n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(2)}%`;
}

// 2026-08-28: shared date+time formatter. Tournament runs multiple days;
// showing just "3:05 PM" hid whether that was today or three days ago.
// "Aug 28, 3:05:15 PM" is short enough to fit inline everywhere the old
// toLocaleTimeString() lived.
function fmtDateTime(input) {
    // Accepts either an ISO string OR a unix-seconds number.
    const d = typeof input === "number"
        ? new Date(input * 1000)
        : new Date(input);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit",
        hour12: true,
    });
}

// Latency formatter — ms is unreadable past ~2s. Reasoning models happily
// take 60-120s; showing "118055ms" made operators think it was a bug.
function fmtLatency(ms) {
    if (ms == null) return "";
    if (ms < 1000) return `${ms} ms`;
    if (ms < 10000) return `${(ms / 1000).toFixed(2)} s`;
    return `${(ms / 1000).toFixed(1)} s`;
}

function pcls(n) {
    if (n == null || Number.isNaN(n)) return "pnl-zero";
    return n > 0 ? "pnl-pos" : (n < 0 ? "pnl-neg" : "pnl-zero");
}

function escapeHtml(s) {
    if (!s) return "";
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

init();
