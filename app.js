(() => {
  const TZ = "America/Denver"; // Salt Lake City venue time; schedule times are in this zone
  const LS_PICKS = "kc26.picks"; // legacy: plain array of ids
  const LS_LOG = "kc26.pickLog"; // { [id]: { on: bool, t: ms } } — mergeable across devices
  const LS_SYNC = "kc26.sync";
  const LS_UI = "kc26.ui";
  const GIST_FILE = "kubecon-2026-planner-picks.json";
  const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=gist&description=KubeCon%202026%20Planner%20sync";
  const $ = (s) => document.querySelector(s);

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let sessions = [];
  let byId = new Map();
  let dataInfo = null; // { source, updated } from sessions.json
  let pickLog = store.get(LS_LOG, null) || Object.fromEntries(store.get(LS_PICKS, []).map((id) => [id, { on: true, t: 1 }]));
  let picks = new Set();
  const derivePicks = () => {
    picks = new Set(Object.keys(pickLog).filter((id) => pickLog[id].on && (!byId.size || byId.has(id))));
  };
  derivePicks();
  const sync = Object.assign({ token: "", gistId: "", last: null, error: "" }, store.get(LS_SYNC, {}));
  const ui = Object.assign(
    { view: "browse", day: null, q: "", track: "", level: "", venue: "", hidePast: false, hideClash: false },
    store.get(LS_UI, {})
  );

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const day = (iso) => iso.slice(0, 10);
  const fmtTime = (iso) => {
    let h = +iso.slice(11, 13), m = iso.slice(14, 16);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  };
  const fmtDay = (d, long) => {
    const dt = new Date(d + "T12:00:00");
    return long
      ? dt.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
      : `${dt.toLocaleDateString("en-US", { weekday: "short" })} ${dt.getDate()}`;
  };
  const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
  const nowVenue = () => new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date()).replace(" ", "T");
  const venueOf = (room) => room.split("|")[0].trim();
  const overlaps = (a, b) => a.start < b.end && b.start < a.end && a.id !== b.id;
  const hue = (str) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const trackColor = (t) => (t ? `hsl(${hue(t)} 65% 50%)` : "var(--line)");

  function clashesFor(s) {
    const out = [];
    for (const id of picks) {
      const p = byId.get(id);
      if (p && overlaps(s, p)) out.push(p);
    }
    return out;
  }

  function save() {
    store.set(LS_LOG, pickLog);
    store.set(LS_UI, ui);
  }

  function setPick(id, on) {
    pickLog[id] = { on, t: Date.now() };
    derivePicks();
    queueSync();
  }

  // ---------- rendering ----------
  function card(s) {
    const picked = picks.has(s.id);
    const clashes = clashesFor(s);
    const clash = clashes.length > 0;
    const chips = [s.track, s.level, ...s.tags].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
    const warn = !clash ? ""
      : picked ? `<div class="warn">⚠ Overlaps: ${clashes.map((c) => esc(c.title)).join("; ")}</div>`
      : `<div class="warn">⚠ Clashes with ${clashes.length} of your picks</div>`;
    return `<div class="card${picked ? " picked" : ""}${picked && clash ? " clash" : ""}" style="--trk:${trackColor(s.track)}">
      <div class="main" data-open="${s.id}">
        <div class="t">${esc(s.title)}</div>
        <div class="m">
          <div>${fmtTime(s.start)} – ${fmtTime(s.end)} · ${esc(s.room)}</div>
          ${s.speakers.length ? `<div>${esc(s.speakers.join(", "))}</div>` : ""}
        </div>
        ${chips ? `<div class="chips">${chips}</div>` : ""}
        ${warn}
      </div>
      <button class="star${picked ? " on" : ""}" data-star="${s.id}" aria-label="${picked ? "Remove from" : "Add to"} my schedule">${picked ? "★" : "☆"}</button>
    </div>`;
  }

  function matches(s) {
    if (day(s.start) !== ui.day) return false;
    if (ui.track && s.track !== ui.track) return false;
    if (ui.level && s.level !== ui.level) return false;
    if (ui.venue && venueOf(s.room) !== ui.venue) return false;
    if (ui.hidePast && s.end <= nowVenue()) return false;
    if (ui.hideClash && !picks.has(s.id) && clashesFor(s).length) return false;
    if (ui.q) {
      const hay = s._hay || (s._hay = [s.title, s.room, s.track, s.level, ...s.tags, ...s.speakers, ...s.description].join(" ").toLowerCase());
      return ui.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    }
    return true;
  }

  function renderBrowse() {
    const list = sessions.filter(matches);
    if (!list.length) return `<div class="empty">No sessions match.</div>`;
    let html = "", cur = null;
    for (const s of list) {
      if (s.start !== cur) {
        if (cur) html += "</section>";
        cur = s.start;
        html += `<section class="slot"><h2>${fmtTime(s.start)}</h2>`;
      }
      html += card(s);
    }
    return html + "</section>" + `<p class="foot">${list.length} session${list.length === 1 ? "" : "s"}</p>`;
  }

  function renderMine() {
    const mine = sessions.filter((s) => picks.has(s.id) && day(s.start) === ui.day);
    const tools = `<div class="tools">
      <button data-act="ics">📅 Export to calendar</button>
      <button data-act="share">🔗 Copy link to my picks</button>
    </div>`;
    if (!mine.length) {
      return `<div class="empty">Nothing picked for ${fmtDay(ui.day, true)}.<br>Tap ☆ on any session in Browse.</div>` + (picks.size ? tools : "");
    }
    let html = "";
    mine.forEach((s, i) => {
      const prev = mine[i - 1];
      if (prev && s.start >= prev.end) {
        const g = mins(prev.end, s.start);
        if (g >= 15) html += `<div class="gap">${g >= 60 ? `${Math.floor(g / 60)}h ${g % 60 ? (g % 60) + "m" : ""}` : g + " min"} free</div>`;
      }
      html += card(s);
    });
    return html + tools;
  }

  function renderDays() {
    const days = [...new Set(sessions.map((s) => day(s.start)))];
    if (!days.includes(ui.day)) {
      const today = nowVenue().slice(0, 10);
      ui.day = days.includes(today) ? today : days.find((d) => sessions.filter((s) => day(s.start) === d).length > 10) || days[0];
    }
    $("#days").innerHTML = days.map((d) => {
      const n = ui.view === "mine" ? sessions.filter((s) => picks.has(s.id) && day(s.start) === d).length : null;
      return `<button data-day="${d}" class="${d === ui.day ? "on" : ""}">${fmtDay(d)}${n ? `<small>★${n}</small>` : ""}</button>`;
    }).join("");
  }

  function render() {
    renderDays();
    document.querySelectorAll(".views button").forEach((b) => b.classList.toggle("on", b.dataset.view === ui.view));
    $("#browseControls").hidden = ui.view !== "browse";
    $("#mineCount").textContent = picks.size;
    const active = ui.track || ui.level || ui.venue || ui.hidePast || ui.hideClash;
    $("#filterDot").hidden = !active;
    $("#list").innerHTML = ui.view === "browse" ? renderBrowse() : renderMine();
    document.documentElement.style.setProperty("--hdr", $(".top").offsetHeight + "px");
    save();
  }

  function openDetail(id) {
    const s = byId.get(id);
    if (!s) return;
    const picked = picks.has(s.id);
    const clashes = clashesFor(s);
    $("#detailBody").innerHTML = `
      <h3>${esc(s.title)}</h3>
      <div class="m">🕒 ${fmtDay(day(s.start), true)} · ${fmtTime(s.start)} – ${fmtTime(s.end)}</div>
      <div class="m">📍 ${esc(s.room)}</div>
      ${s.speakers.length ? `<div class="m">🎤 ${esc(s.speakers.join(", "))}</div>` : ""}
      <div class="chips">${[s.track, s.level, ...s.tags].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      ${clashes.length ? `<div class="warn">⚠ Overlaps with: ${clashes.map((c) => esc(c.title)).join("; ")}</div>` : ""}
      <button class="bigstar${picked ? " on" : ""}" data-star="${s.id}">${picked ? "★ In my schedule" : "☆ Add to my schedule"}</button>
      ${s.description.map((p) => `<p>${esc(p)}</p>`).join("")}
      <p>${s.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a> · `).join("")}<a href="${esc(s.url)}" target="_blank" rel="noopener">Official listing ↗</a></p>`;
    const dlg = $("#detail");
    if (!dlg.open) dlg.showModal();
    dlg.dataset.id = id;
  }

  function toggle(id) {
    setPick(id, !picks.has(id));
    render();
    if ($("#detail").open) openDetail($("#detail").dataset.id);
  }

  // ---------- export / share ----------
  function exportIcs() {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const dt = (iso) => iso.replace(/[-:]/g, "").slice(0, 15);
    const icsEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
    const fold = (line) => line.match(/.{1,70}/gu).join("\r\n ");
    const ev = sessions.filter((s) => picks.has(s.id)).map((s) => [
      "BEGIN:VEVENT",
      `UID:kc26-${s.id}@kubecon-planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${TZ}:${dt(s.start)}`,
      `DTEND;TZID=${TZ}:${dt(s.end)}`,
      fold(`SUMMARY:${icsEsc(s.title)}`),
      fold(`LOCATION:${icsEsc(s.room)}`),
      fold(`DESCRIPTION:${icsEsc([s.speakers.join(", "), s.url].filter(Boolean).join("\n"))}`),
      `URL:${s.url}`,
      "END:VEVENT",
    ].join("\r\n"));
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kubecon-2026-planner//EN", ...ev, "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    a.download = "kubecon-2026-my-schedule.ics";
    a.click();
  }

  async function share() {
    const url = location.origin + location.pathname + "#picks=" + [...picks].join(",");
    try {
      if (navigator.share) await navigator.share({ title: "My KubeCon schedule", url });
      else { await navigator.clipboard.writeText(url); alert("Link copied. Open it on another device to import your picks."); }
    } catch { prompt("Copy this link:", url); }
  }

  function importFromHash() {
    const m = location.hash.match(/picks=([\d,]+)/);
    if (!m) return;
    const ids = m[1].split(",").filter((id) => byId.has(id));
    history.replaceState(null, "", location.pathname);
    const fresh = ids.filter((id) => !picks.has(id));
    if (fresh.length && confirm(`Import ${fresh.length} session(s) into your schedule?`)) {
      fresh.forEach((id) => setPick(id, true));
      ui.view = "mine";
    }
  }

  // ---------- GitHub Gist sync ----------
  // Each device keeps a log of {on, t} per session; logs merge by newest timestamp,
  // so un-starring on one device isn't undone by a stale copy on another.
  let syncing = false, syncAgain = false, syncTimer;

  const validLog = (o) => Object.fromEntries(Object.entries(o || {}).filter(
    ([id, v]) => /^\d+$/.test(id) && v && typeof v.on === "boolean" && Number.isFinite(v.t)
  ));
  const mergeLogs = (a, b) => {
    const out = { ...a };
    for (const [id, v] of Object.entries(b)) if (!out[id] || v.t > out[id].t) out[id] = v;
    return out;
  };
  const sameLog = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((id) => b[id] && b[id].on === a[id].on && b[id].t === a[id].t);
  };

  async function gh(path, opts = {}) {
    const r = await fetch("https://api.github.com" + path, {
      ...opts,
      cache: "no-store",
      headers: { Authorization: `Bearer ${sync.token}`, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) {
      const err = new Error(
        r.status === 401 ? "GitHub rejected the token (expired or revoked?)."
        : r.status === 403 ? "Token is missing the gist scope, or GitHub rate-limited the request."
        : `GitHub error ${r.status}.`
      );
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function findOrCreateGist() {
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      const g = list.find((g) => g.files && g.files[GIST_FILE]);
      if (g) return g.id;
      if (list.length < 100) break;
    }
    const g = await gh("/gists", {
      method: "POST",
      body: JSON.stringify({
        description: "KubeCon NA 2026 Planner: my picks (synced by the app, don't rename)",
        public: false,
        files: { [GIST_FILE]: { content: JSON.stringify({ picks: {} }) } },
      }),
    });
    return g.id;
  }

  async function readGist() {
    let g;
    try {
      g = await gh(`/gists/${sync.gistId}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      sync.gistId = await findOrCreateGist(); // gist was deleted; start a new one
      return {};
    }
    const f = g.files[GIST_FILE];
    if (!f) return {};
    const text = f.truncated ? await (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
    try { return validLog(JSON.parse(text).picks); } catch { return {}; }
  }

  async function runSync() {
    if (!sync.token) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    renderSyncStatus("Syncing…");
    try {
      if (!sync.gistId) sync.gistId = await findOrCreateGist();
      const remote = await readGist();
      const merged = mergeLogs(pickLog, remote);
      if (!sameLog(merged, remote)) {
        await gh(`/gists/${sync.gistId}`, {
          method: "PATCH",
          body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify({ picks: merged }, null, 1) } } }),
        });
      }
      // Merge again in case the user starred something while we were waiting on the network.
      const next = mergeLogs(pickLog, merged);
      if (!sameLog(next, pickLog)) {
        pickLog = next;
        derivePicks();
        render();
      }
      sync.last = new Date().toISOString();
      sync.error = "";
    } catch (e) {
      sync.error = navigator.onLine === false ? "Offline: will sync when you're back online." : e.message;
    } finally {
      syncing = false;
      store.set(LS_SYNC, sync);
      renderSyncStatus();
      if (syncAgain) { syncAgain = false; runSync(); }
    }
  }

  function queueSync() {
    if (!sync.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, 1000);
  }

  function renderSyncStatus(msg) {
    const btn = $("#syncBtn");
    btn.className = "syncbtn" + (!sync.token ? "" : sync.error ? " err" : " ok");
    btn.title = !sync.token ? "Sync is off" : sync.error || "Synced";
    if ($("#syncDlg").open) renderSyncDialog(msg);
    renderFoot();
  }

  function renderSyncDialog(msg) {
    const last = sync.last ? new Date(sync.last).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "never";
    const status = msg || (sync.error ? `<span class="bad">⚠ ${esc(sync.error)}</span>` : `✓ Last synced ${esc(last)}`);
    $("#syncBody").innerHTML = sync.token
      ? `<h3>Sync is on</h3>
        <p class="m">${status}</p>
        <p class="m">Your picks are stored in a <a href="https://gist.github.com/${esc(sync.gistId)}" target="_blank" rel="noopener">secret gist</a> in your GitHub account. They sync automatically when you star a session or open the app.</p>
        <div class="tools">
          <button data-act="sync-now">⟳ Sync now</button>
          <button data-act="sync-off">Turn off on this device</button>
        </div>`
      : `<h3>Sync across devices</h3>
        <p class="m">Keep your picks in sync between your phone and laptop by storing them in a secret GitHub Gist in your account.</p>
        <ol class="steps">
          <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Create a GitHub token ↗</a>. The <b>gist</b> scope is already selected; leave everything else off and set the expiration past Nov 12. Then generate and copy it.</li>
          <li>Paste it below. Do this once on each device.</li>
        </ol>
        <input id="tokenIn" type="password" placeholder="ghp_…" autocomplete="off" spellcheck="false">
        <button class="bigstar on" data-act="sync-connect">Connect</button>
        ${msg || sync.error ? `<p class="m">${msg || `<span class="bad">⚠ ${esc(sync.error)}</span>`}</p>` : ""}
        <p class="m small">The token stays in this browser only and can only read/write your gists. You can revoke it anytime in GitHub settings.</p>`;
  }

  async function connectSync() {
    const token = $("#tokenIn").value.trim();
    if (!token) return;
    Object.assign(sync, { token, gistId: "", error: "", last: null });
    await runSync();
    if (sync.error && /rejected|scope/.test(sync.error)) {
      sync.token = ""; // don't keep a token that doesn't work
      store.set(LS_SYNC, sync);
    }
    renderSyncStatus();
  }

  function disconnectSync() {
    if (!confirm("Turn off sync on this device? Your picks stay here and in the gist.")) return;
    Object.assign(sync, { token: "", gistId: "", error: "", last: null });
    store.set(LS_SYNC, sync);
    renderSyncStatus();
  }

  function renderFoot() {
    if (!dataInfo) return;
    $("#foot").innerHTML = `Schedule data from <a href="${esc(dataInfo.source)}" target="_blank" rel="noopener">events.linuxfoundation.org</a> · updated ${new Date(dataInfo.updated).toLocaleString()}<br>Times shown in venue time (Mountain). Picks are ${sync.token ? "synced via your GitHub Gist" : "saved on this device. Tap ☁ to sync"}.`;
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-star],[data-open],[data-day],[data-view],[data-act]");
    if (!t) return;
    if (t.dataset.star) toggle(t.dataset.star);
    else if (t.dataset.open) openDetail(t.dataset.open);
    else if (t.dataset.day) { ui.day = t.dataset.day; render(); window.scrollTo(0, 0); }
    else if (t.dataset.view) { ui.view = t.dataset.view; render(); window.scrollTo(0, 0); }
    else if (t.dataset.act === "ics") exportIcs();
    else if (t.dataset.act === "share") share();
    else if (t.dataset.act === "sync-open") { renderSyncDialog(); $("#syncDlg").showModal(); }
    else if (t.dataset.act === "sync-connect") connectSync();
    else if (t.dataset.act === "sync-now") runSync();
    else if (t.dataset.act === "sync-off") disconnectSync();
  });
  for (const id of ["detail", "syncDlg"]) {
    const dlg = document.getElementById(id);
    dlg.querySelector(".close").onclick = () => dlg.close();
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") runSync(); });
  window.addEventListener("online", runSync);

  let qTimer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { ui.q = e.target.value.trim(); render(); }, 150);
  });
  $("#filterBtn").onclick = () => {
    const f = $("#filters");
    f.hidden = !f.hidden;
    $("#filterBtn").setAttribute("aria-expanded", !f.hidden);
    document.documentElement.style.setProperty("--hdr", $(".top").offsetHeight + "px");
  };
  const bind = (sel, key, prop = "value") => $(sel).addEventListener("change", (e) => { ui[key] = e.target[prop]; render(); });
  bind("#fTrack", "track");
  bind("#fLevel", "level");
  bind("#fVenue", "venue");
  bind("#fPast", "hidePast", "checked");
  bind("#fConflict", "hideClash", "checked");
  $("#clearFilters").onclick = () => {
    Object.assign(ui, { track: "", level: "", venue: "", hidePast: false, hideClash: false, q: "" });
    syncControls();
    render();
  };
  window.addEventListener("resize", () => document.documentElement.style.setProperty("--hdr", $(".top").offsetHeight + "px"));

  function fillSelect(sel, values) {
    $(sel).insertAdjacentHTML("beforeend", values.map((v) => `<option>${esc(v)}</option>`).join(""));
  }
  function syncControls() {
    $("#q").value = ui.q;
    $("#fTrack").value = ui.track;
    $("#fLevel").value = ui.level;
    $("#fVenue").value = ui.venue;
    $("#fPast").checked = ui.hidePast;
    $("#fConflict").checked = ui.hideClash;
  }

  // ---------- load ----------
  fetch("sessions.json", { cache: "no-cache" })
    .then((r) => r.json())
    .then((data) => {
      sessions = data.sessions;
      byId = new Map(sessions.map((s) => [s.id, s]));
      derivePicks(); // hides picks for sessions removed from the schedule
      const uniq = (f) => [...new Set(sessions.map(f).filter(Boolean))].sort();
      fillSelect("#fTrack", uniq((s) => s.track));
      fillSelect("#fLevel", uniq((s) => s.level));
      fillSelect("#fVenue", uniq((s) => venueOf(s.room)));
      syncControls();
      importFromHash();
      dataInfo = { source: data.source, updated: data.updated };
      render();
      renderSyncStatus();
      runSync();
    })
    .catch(() => { $("#list").innerHTML = `<div class="empty">Couldn't load the schedule. Pull to refresh.</div>`; });
})();
