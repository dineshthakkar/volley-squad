/* Volley Squad — Phase 2 (players in Supabase cloud; drills in localStorage).
 * - Coach view: manage roster + drills + overview. Players sync to the cloud.
 * - Player view (open with ?player): tap your name, pick/change your position.
 * - Falls back to LOCAL mode if Supabase isn't configured.
 */
(function () {
  "use strict";

  // Build version — bump this AND the ?v= query strings in index.html on each
  // meaningful release so browsers/PWAs fetch fresh code instead of a cached copy.
  const BUILD = "v10";

  const DRILLS_KEY = "vbcoach.drills.v1";
  const LOCAL_PLAYERS_KEY = "vbcoach.v1"; // legacy/local roster (used for migration + offline fallback)

  // ---- positions ----
  const POSITION_DEFS = [
    { key: "Outside Hitter",         label: "Outside Hitter (front-left · Zone 4)",            zone: 4, order: 1 },
    { key: "Middle Blocker",         label: "Middle Blocker (front-center · Zone 3)",          zone: 3, order: 2 },
    { key: "Setter / Opposite",      label: "Setter / Opposite (front-right · Zone 2)",        zone: 2, order: 3 },
    { key: "Defensive Specialist – Left",  label: "Defensive Specialist – Left (back-left · Zone 5)",  zone: 5, order: 4 },
    { key: "Libero",                 label: "Libero (back-center · Zone 6)",                   zone: 6, order: 5 },
    { key: "Defensive Specialist – Right", label: "Defensive Specialist – Right (back-right · Zone 1)", zone: 1, order: 6 },
  ];

  // Legacy position keys (pre-merge) → their new merged key. Used to migrate the
  // cloud (players.position + drills.position) to the merged "Setter / Opposite"
  // once, on coach load. Idempotent: only rewrites these exact old keys.
  const LEGACY_POSITION_MAP = {
    "Setter": "Setter / Opposite",
    "Opposite / Right Side": "Setter / Opposite",
  };
  function canonPosition(key) { return LEGACY_POSITION_MAP[key] || key || ""; }
  const POSITIONS = POSITION_DEFS.map(p => p.key);
  const POS_LABEL = {}; const POS_ORDER = {};
  POSITION_DEFS.forEach(p => { POS_LABEL[p.key] = p.label; POS_ORDER[p.key] = p.order; });
  function posLabel(key) { return POS_LABEL[key] || key; }

  // "Common" drills apply to every position (e.g. underarm serve, passing video).
  // Stored as its own row in the `drills` table (position = COMMON_KEY) so adding
  // one entry here shows up for all 7 positions instead of needing to be copy-pasted
  // into each position's list.
  const COMMON_KEY = "__common__";
  const COMMON_LABEL = "Common — all positions";

  // Drills tuned for this team's style: NO rotation (players hold their spot) and a
  // DIRECT-PASS game (receive the ball and send it back over the net in 1–2 touches —
  // not pass→set→spike). Focus: serve receive, controlled passing, directing the ball
  // back over, serving, and covering your own zone.
  const DEFAULT_DRILLS = {
    "Setter / Opposite": [
      "Receive at the net & redirect over (1–2 touches)",
      "Overhead control: clean two-hand return over the net",
      "Tip/dump placement into open court",
      "Cover the front-right zone (short & deep balls)",
      "Set-to-self then return over (ball control)",
      "Handle hard-driven balls to the right side",
      "Placement: find the open area across the net"
    ],
    "Outside Hitter": [
      "Serve-receive from front-left, platform to target",
      "Direct return over the net off a hard-driven ball",
      "Angle control: send it cross-court vs down the line",
      "Cover front-left zone (short tips + deep drives)",
      "Attack-to-pass: controlled downball over the net"
    ],
    "Middle Blocker": [
      "Receive at the net (front-center) & redirect over",
      "Return hard-driven balls hit straight at you",
      "Soft block / rebound control back over the net",
      "Cover front-center zone (short dinks + deep)",
      "Two-hand overhead return under control"
    ],
    "Libero": [
      "Serve-receive passing (platform to a clean target)",
      "Dig hard-driven balls & return deep over the net",
      "Controlled return over the net (don't overpass)",
      "Cover back-center zone & call the ball",
      "Emergency passes: run-through & pursuit"
    ],
    "Defensive Specialist – Left": [
      "Serve-receive from Zone 5 (back-left) to target",
      "Dig & direct the ball back over on first touch",
      "Read the server / hitter and move early",
      "Cover back-left zone (deep corners)",
      "Serve: consistent deep serves to the opponent"
    ],
    "Defensive Specialist – Right": [
      "Serve-receive from Zone 1 (back-right) to target",
      "Dig & direct the ball back over on first touch",
      "Read the server / hitter and move early",
      "Cover back-right zone (deep corners)",
      "Serve from Zone 1: placement to the open court"
    ],
  };

  // Drills shared by every position regardless of role.
  const DEFAULT_COMMON_DRILLS = [
    "Passing Video: https://www.youtube.com/watch?v=gOgfoEGUDCA",
    "Under arm serve video: https://www.youtube.com/watch?v=7SrLyQv1WUY"
  ];

  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---- team passcodes (two roles; gate via x-team-pass header + Supabase RLS) ----
  // Player code = view + update position. Coach code = add/delete/import/manage.
  // NEITHER code is hardcoded with coach power in the public JS: the coach types the
  // coach code once in the coach view and it's stored in this browser only.
  const PASS_KEY = "vbcoach.teampass";
  function getPass() { try { return localStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; } }
  function setPass(v) { try { localStorage.setItem(PASS_KEY, v); } catch (e) {} }

  // ---- Supabase client ----
  let sb = null, cloud = false;
  (function initSupabase() {
    try {
      const cfg = window.VB_SUPABASE;
      if (cfg && cfg.url && cfg.anonKey &&
          cfg.url.indexOf("YOUR_") < 0 && cfg.anonKey.indexOf("YOUR_") < 0 &&
          window.supabase && window.supabase.createClient) {
        sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
          global: { headers: { "x-team-pass": getPass() } }
        });
        cloud = true;
      }
    } catch (e) { cloud = false; }
  })();

  // Rebuild the client with a given passcode (after coach/player enters it).
  function rebuildClientWithPass(pass) {
    const cfg = window.VB_SUPABASE;
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      global: { headers: { "x-team-pass": pass } }
    });
  }

  // ---- players state ----
  let players = []; // {id, name, num, position, drills[]}

  // True once the coach has entered a passcode AND coachLoad() has finished
  // successfully. Writes (add/edit/delete drills, roster edits) must not fire
  // before this — the Supabase client has no coach auth header yet, so any
  // write would be rejected by RLS and only show up as a vague "save failed".
  let coachUnlocked = false;

  // ---- drills (now in Supabase: coach edits, players read) ----
  let drills = structuredCloneSafe(DEFAULT_DRILLS); // in-memory; loaded from cloud

  async function cloudLoadDrills() {
    const { data, error } = await sb.from("drills").select("position,items");
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[r.position] = r.items || []; });
    // ensure every known position (+ the common bucket) has an entry (fall back to default if missing)
    const out = {};
    out[COMMON_KEY] = map[COMMON_KEY] !== undefined ? map[COMMON_KEY] : DEFAULT_COMMON_DRILLS.slice();
    POSITIONS.forEach(pos => { out[pos] = map[pos] !== undefined ? map[pos] : (DEFAULT_DRILLS[pos] || []).slice(); });
    return out;
  }
  async function cloudSaveDrillPosition(pos) {
    // upsert one position's drill list (coach only)
    const { error } = await sb.from("drills").upsert({ position: pos, items: drills[pos] || [], updated_at: new Date().toISOString() }, { onConflict: "position" });
    if (error) throw error;
  }

  // legacy local drills (used only to migrate up the first time)
  function loadLocalDrills() {
    try { const r = localStorage.getItem(DRILLS_KEY); if (r) return JSON.parse(r); } catch (e) {}
    return null;
  }

  function loadLocalPlayers() {
    try { const r = localStorage.getItem(LOCAL_PLAYERS_KEY); if (r) return (JSON.parse(r).players || []); } catch (e) {}
    return [];
  }
  function saveLocalPlayers() {
    // keep a local mirror (offline fallback + migration source)
    try { localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify({ players: players, drills: drills })); } catch (e) {}
  }

  // ---- cloud mappers ----
  function rowToPlayer(r) {
    return { id: r.id, name: r.name, num: r.num || "", position: r.position || "", drills: r.drills || [], sort_order: r.sort_order || 0 };
  }
  function playerToRow(p) {
    return { name: p.name, num: p.num || "", position: p.position || "", drills: p.drills || [], sort_order: p.sort_order || 0 };
  }

  // ---- cloud ops (promise-based) ----
  async function cloudFetch() {
    const { data, error } = await sb.from("players").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true });
    if (error) throw error;
    return data.map(rowToPlayer);
  }
  async function cloudInsert(p) {
    const { data, error } = await sb.from("players").insert(playerToRow(p)).select().single();
    if (error) throw error;
    return rowToPlayer(data);
  }
  async function cloudUpdate(id, patch) {
    const { error } = await sb.from("players").update(patch).eq("id", id);
    if (error) throw error;
  }
  async function cloudDelete(id) {
    const { error } = await sb.from("players").delete().eq("id", id);
    if (error) throw error;
  }

  // ---- status note ----
  function setStatus(msg, kind) {
    const el = document.getElementById("savedNote");
    if (!el) return;
    el.textContent = msg;
    el.style.color = kind === "err" ? "#ffd7d2" : (kind === "ok" ? "#d6ffd0" : "#dbe7ff");
  }

  // ============================================================
  //  ROUTER: coach view vs player self-select view
  // ============================================================
  const isPlayerView = /[?&]player\b/.test(location.search);

  // ============================================================
  //  COACH VIEW
  // ============================================================
  function initCoach() {
    document.getElementById("coachApp").style.display = "";
    document.getElementById("playerApp").style.display = "none";

    // tabs
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        if (cloud && !coachUnlocked) { setStatus("locked — enter the coach passcode first", "err"); return; }
        document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
        document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        document.getElementById(t.dataset.tab).classList.add("active");
        if (t.dataset.tab === "overview") renderOverview();
        if (t.dataset.tab === "drills") renderDrills();
      });
    });

    // add player
    const addForm = document.getElementById("addPlayerForm");
    addForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      const name = document.getElementById("playerName").value.trim();
      const num = document.getElementById("playerNum").value.trim();
      if (!name) return;
      const p = { id: uid(), name: name, num: num, position: "", drills: [], sort_order: players.length };
      if (cloud) {
        try { setStatus("saving…"); const saved = await cloudInsert(p); players.push(saved); setStatus("synced", "ok"); }
        catch (err) { setStatus("save failed", "err"); alert("Could not save to cloud: " + err.message); return; }
      } else { players.push(p); saveLocalPlayers(); }
      addForm.reset();
      renderRoster();
      document.getElementById("playerName").focus();
    });

    // import
    document.getElementById("importBtn").addEventListener("click", onImport);
    // reset drills
    document.getElementById("resetDrills").addEventListener("click", onResetDrills);
    // filter + refresh + export + print
    document.getElementById("filterPos").addEventListener("change", renderOverview);
    document.getElementById("refreshBtn").addEventListener("click", async function () { await reloadPlayers(); renderOverview(); });
    document.getElementById("exportBtn").addEventListener("click", onExport);
    document.getElementById("printBtn").addEventListener("click", function () { window.print(); });
    // share link
    const shareBtn = document.getElementById("sharePlayerLink");
    if (shareBtn) shareBtn.addEventListener("click", onShareLink);
    // migrate
    const migrateBtn = document.getElementById("migrateBtn");
    if (migrateBtn) migrateBtn.addEventListener("click", onMigrate);

    bootstrapCoach();
  }

  async function reloadPlayers() {
    if (cloud) {
      try { players = await cloudFetch(); setStatus("synced", "ok"); }
      catch (err) { setStatus("offline — using local", "err"); players = loadLocalPlayers(); cloud = false; }
    } else { players = loadLocalPlayers(); }
  }

  async function bootstrapCoach() {
    const footer = document.getElementById("coachFooter");
    if (!cloud) {
      setStatus("local mode (no cloud configured)");
      if (footer) footer.textContent = "Local mode — roster saved only on this device.";
      players = loadLocalPlayers();
      coachUnlocked = true; // no RLS gate in local mode; writes just go to localStorage
      renderRoster();
      return;
    }
    // Coach must enter the coach code once (stored in this browser). Nothing is baked into the public JS.
    if (!getPass()) { showCoachPassPrompt(); return; }
    await coachLoad();
  }

  function showCoachPassPrompt(wrong) {
    coachUnlocked = false;
    setStatus("locked");
    const list = document.getElementById("playerList");
    document.getElementById("rosterEmpty").style.display = "none";
    const sr = document.getElementById("shareRow"); if (sr) sr.style.display = "none";
    list.innerHTML =
      '<div class="pcard" style="max-width:380px">' +
      '<div class="lbl" style="margin-bottom:8px">Enter the COACH passcode</div>' +
      (wrong ? '<div class="saveflash" style="color:var(--bad)">Incorrect coach passcode — try again.</div>' : '') +
      '<div class="row"><input id="coachPassInput" type="password" placeholder="coach passcode" ' +
      'style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:15px"> ' +
      '<button id="coachPassGo" class="primary small">Unlock</button></div>' +
      '<div class="muted small" style="margin-top:6px">Coach-only. Players use the separate self-select link.</div>' +
      '</div>';
    const go = async function () {
      const v = document.getElementById("coachPassInput").value.trim();
      if (!v) return;
      rebuildClientWithPass(v);
      // Verify it's the COACH code by probing an insert (coach-only) then deleting the probe.
      try {
        const { data, error } = await sb.from("players")
          .insert({ name: "__coachcheck__", sort_order: -9999 }).select().single();
        if (error) throw error;                 // player code or wrong -> insert rejected
        await sb.from("players").delete().eq("id", data.id);
        setPass(v);
        await coachLoad();
      } catch (e) {
        showCoachPassPrompt(true);
      }
    };
    document.getElementById("coachPassGo").addEventListener("click", go);
    document.getElementById("coachPassInput").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }

  async function coachLoad() {
    setStatus("connecting…");
    await reloadPlayers();
    // load drills from cloud; if cloud has none yet, migrate the direct-pass defaults up
    try {
      const { data } = await sb.from("drills").select("position");
      if (!data || data.length === 0) {
        const seed = loadLocalDrills() || DEFAULT_DRILLS;
        drills = {};
        drills[COMMON_KEY] = DEFAULT_COMMON_DRILLS.slice();
        POSITIONS.forEach(pos => { drills[pos] = (seed[pos] || DEFAULT_DRILLS[pos] || []).slice(); });
        const rows = [{ position: COMMON_KEY, items: drills[COMMON_KEY], updated_at: new Date().toISOString() }]
          .concat(POSITIONS.map(pos => ({ position: pos, items: drills[pos], updated_at: new Date().toISOString() })));
        await sb.from("drills").upsert(rows, { onConflict: "position" });
      } else {
        drills = await cloudLoadDrills();
      }
    } catch (e) { /* keep in-memory defaults if drills load fails */ }
    // One-time merge of the old Setter / Opposite positions into "Setter / Opposite".
    try { await migratePositions(); } catch (e) { /* non-fatal; log via status */ setStatus("position merge skipped: " + e.message, "err"); }
    coachUnlocked = true;
    const sr = document.getElementById("shareRow"); if (sr) sr.style.display = "";
    const local = loadLocalPlayers();
    if (players.length === 0 && local.length > 0) {
      const mb = document.getElementById("migrateBox");
      document.getElementById("migrateCount").textContent = local.length;
      if (mb) mb.style.display = "";
    }
    renderRoster();
  }

  // One-time, idempotent migration: fold the pre-merge "Setter" and "Opposite / Right Side"
  // positions into the single merged "Setter / Opposite". Rewrites players.position and
  // consolidates the two legacy drills rows (merge + dedupe) into one. Coach-only (needs
  // is_coach() to write). Safe to run every coach load — it no-ops once nothing legacy remains.
  async function migratePositions() {
    if (!cloud) return;
    const MERGED = "Setter / Opposite";
    const LEGACY = Object.keys(LEGACY_POSITION_MAP); // ["Setter", "Opposite / Right Side"]

    // --- 1. players.position ---
    // Reload raw rows so we see the stored (possibly legacy) values directly.
    const { data: prows, error: perr } = await sb.from("players").select("id,position");
    if (perr) throw perr;
    const toFix = (prows || []).filter(r => LEGACY.indexOf(r.position) >= 0);
    for (const r of toFix) {
      const { error } = await sb.from("players").update({ position: MERGED }).eq("id", r.id);
      if (error) throw error;
    }

    // --- 2. drills rows ---
    const { data: drows, error: derr } = await sb.from("drills").select("position,items");
    if (derr) throw derr;
    const byPos = {};
    (drows || []).forEach(r => { byPos[r.position] = r.items || []; });
    const hasLegacyDrills = LEGACY.some(k => byPos[k] !== undefined);
    if (hasLegacyDrills) {
      // Merge any legacy lists + an existing merged list, dedupe preserving order.
      const merged = [];
      const seen = new Set();
      const pushAll = arr => (arr || []).forEach(d => { if (!seen.has(d)) { seen.add(d); merged.push(d); } });
      pushAll(byPos[MERGED]);          // keep anything already under the new key first
      LEGACY.forEach(k => pushAll(byPos[k]));
      // Write the consolidated row, then delete the legacy rows.
      const { error: upErr } = await sb.from("drills")
        .upsert({ position: MERGED, items: merged, updated_at: new Date().toISOString() }, { onConflict: "position" });
      if (upErr) throw upErr;
      for (const k of LEGACY) {
        if (byPos[k] === undefined) continue;
        const { error } = await sb.from("drills").delete().eq("position", k);
        if (error) throw error;
      }
      drills[MERGED] = merged;          // reflect in memory
    }

    // Refresh in-memory state if we changed anything.
    if (toFix.length || hasLegacyDrills) {
      await reloadPlayers();
      try { drills = await cloudLoadDrills(); } catch (e) {}
      setStatus("merged Setter/Opposite (" + toFix.length + " players)", "ok");
    }
  }

  async function onMigrate() {
    const local = loadLocalPlayers();
    if (!local.length) return;
    const btn = document.getElementById("migrateBtn");
    btn.disabled = true;
    document.getElementById("migrateMsg").textContent = " uploading…";
    try {
      // insert all, preserving order
      const rows = local.map((p, i) => ({ name: p.name, num: p.num || "", position: p.position || "", drills: p.drills || [], sort_order: i }));
      const { error } = await sb.from("players").insert(rows);
      if (error) throw error;
      await reloadPlayers();
      document.getElementById("migrateBox").style.display = "none";
      renderRoster();
      setStatus("synced", "ok");
    } catch (err) {
      document.getElementById("migrateMsg").textContent = " failed: " + err.message;
      btn.disabled = false;
    }
  }

  function onShareLink() {
    const url = location.origin + location.pathname + "?player";
    const msg = document.getElementById("shareMsg");
    navigator.clipboard.writeText(url).then(
      () => { msg.textContent = "Copied! Send players this link + the PLAYER code (win2027cup) — not your coach code."; },
      () => { msg.textContent = url + "  (player code: win2027cup)"; }
    );
  }

  // ---- roster render (coach) ----
  function renderRoster() {
    const list = document.getElementById("playerList");
    const empty = document.getElementById("rosterEmpty");
    list.innerHTML = "";
    document.getElementById("playerCount").textContent = players.length;
    empty.style.display = players.length ? "none" : "block";

    players.forEach(function (p) {
      const card = document.createElement("div");
      card.className = "pcard";
      const top = document.createElement("div");
      top.className = "ptop";

      const jersey = document.createElement("input");
      jersey.className = "jersey jersey-edit";
      jersey.type = "number";
      jersey.min = "0";
      jersey.max = "99";
      jersey.step = "1";
      jersey.placeholder = "#";
      jersey.title = "Jersey number (tap to edit)";
      jersey.value = p.num != null && p.num !== "" ? p.num : "";
      const saveNum = async function () {
        const raw = jersey.value.trim();
        const next = raw === "" ? null : parseInt(raw, 10);
        if (raw !== "" && (isNaN(next) || next < 0 || next > 99)) {
          jersey.value = p.num != null ? p.num : "";   // revert invalid entry
          return;
        }
        if (next === p.num) return;                     // nothing changed
        const prev = p.num;
        p.num = next;
        if (cloud) {
          try { setStatus("saving…"); await cloudUpdate(p.id, { num: next }); setStatus("synced", "ok"); }
          catch (e) { p.num = prev; jersey.value = prev != null ? prev : ""; setStatus("save failed", "err"); }
        } else { saveLocalPlayers(); }
      };
      jersey.addEventListener("change", saveNum);
      jersey.addEventListener("blur", saveNum);
      // Enter commits + unfocuses (never submits a form)
      jersey.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); jersey.blur(); } });

      const nm = document.createElement("span");
      nm.className = "pname";
      nm.textContent = p.name;

      const sel = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = "— position —";
      sel.appendChild(blank);
      POSITIONS.forEach(function (pos) {
        const o = document.createElement("option");
        o.value = pos; o.textContent = posLabel(pos);
        if (p.position === pos) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", async function () {
        p.position = sel.value;
        if (cloud) { try { setStatus("saving…"); await cloudUpdate(p.id, { position: p.position }); setStatus("synced", "ok"); } catch (e) { setStatus("save failed", "err"); } }
        else { saveLocalPlayers(); }
      });

      const del = document.createElement("button");
      del.className = "del";
      del.title = "Remove player";
      del.textContent = "✕";
      del.addEventListener("click", async function () {
        if (!confirm("Remove " + p.name + "?")) return;
        if (cloud) { try { await cloudDelete(p.id); } catch (e) { alert("Delete failed: " + e.message); return; } }
        players = players.filter(x => x.id !== p.id);
        if (!cloud) saveLocalPlayers();
        renderRoster();
      });

      top.appendChild(jersey); top.appendChild(nm); top.appendChild(sel); top.appendChild(del);
      card.appendChild(top);

      list.appendChild(card);
    });

    refreshFilterOptions();
  }

  // ---- drill library (local) ----
  function renderDrills() {
    const root = document.getElementById("drillLibrary");
    root.innerHTML = "";

    // Common box first — applies to every position (e.g. underarm serve, passing video).
    root.appendChild(drillBox(COMMON_KEY, COMMON_LABEL, "poslib poslib-common"));

    POSITIONS.forEach(function (pos) {
      root.appendChild(drillBox(pos, posLabel(pos), "poslib"));
    });
  }

  // Build one drill box (used for both the common bucket and each position).
  function drillBox(key, label, className) {
    const box = document.createElement("div");
    box.className = className;
    const h = document.createElement("h3");
    h.textContent = label;
    box.appendChild(h);
    (drills[key] || []).forEach(function (d, idx) { box.appendChild(drillRow(key, idx)); });
    const add = document.createElement("button");
    add.className = "addDrill";
    add.textContent = "+ add drill";
    add.addEventListener("click", async function () {
      if (!drills[key]) drills[key] = [];
      drills[key].push("New drill");
      await saveDrillPos(key); renderDrills();
    });
    box.appendChild(add);
    return box;
  }

  // Save one position's drills to the cloud (coach only); falls back silently if offline.
  async function saveDrillPos(pos) {
    if (!cloud) return;
    if (!coachUnlocked) { setStatus("locked — enter the coach passcode first", "err"); return; }
    try { setStatus("saving…"); await cloudSaveDrillPosition(pos); setStatus("synced", "ok"); }
    catch (e) { setStatus("save failed: " + e.message, "err"); }
  }

  function drillRow(pos, idx) {
    const row = document.createElement("div");
    row.className = "drillrow";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = drills[pos][idx];
    inp.addEventListener("change", async function () {
      const old = drills[pos][idx];
      const val = inp.value.trim() || old;
      drills[pos][idx] = val;
      await saveDrillPos(pos);
    });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete drill";
    del.addEventListener("click", async function () {
      drills[pos].splice(idx, 1);
      await saveDrillPos(pos); renderDrills();
    });
    row.appendChild(inp); row.appendChild(del);
    return row;
  }

  async function onResetDrills() {
    if (cloud && !coachUnlocked) { setStatus("locked — enter the coach passcode first", "err"); return; }
    if (confirm("Reset the drill library to the default (direct-pass) set and save to the cloud?")) {
      drills = structuredCloneSafe(DEFAULT_DRILLS);
      drills[COMMON_KEY] = DEFAULT_COMMON_DRILLS.slice();
      if (cloud) {
        try {
          setStatus("saving…");
          const rows = [{ position: COMMON_KEY, items: drills[COMMON_KEY], updated_at: new Date().toISOString() }]
            .concat(POSITIONS.map(pos => ({ position: pos, items: drills[pos] || [], updated_at: new Date().toISOString() })));
          const { error } = await sb.from("drills").upsert(rows, { onConflict: "position" });
          if (error) throw error;
          setStatus("synced", "ok");
        } catch (e) { setStatus("save failed: " + e.message, "err"); }
      }
      renderDrills();
    }
  }

  // ---- overview ----
  function refreshFilterOptions() {
    const sel = document.getElementById("filterPos");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All positions</option>';
    POSITIONS.forEach(function (pos) {
      const o = document.createElement("option");
      o.value = pos; o.textContent = posLabel(pos);
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  let overviewSort = { key: "position", dir: 1 };
  function renderOverview() {
    renderCoachCourt();
    const root = document.getElementById("overviewTable");
    const filter = document.getElementById("filterPos").value;
    const rows = players.filter(p => !filter || p.position === filter);
    const k = overviewSort.key, dir = overviewSort.dir;
    rows.sort(function (a, b) {
      let cmp = 0;
      if (k === "num") {
        const na = a.num === "" || a.num == null ? Infinity : parseInt(a.num, 10);
        const nb = b.num === "" || b.num == null ? Infinity : parseInt(b.num, 10);
        if (na === Infinity && nb === Infinity) cmp = 0;
        else if (na === Infinity) return 1;
        else if (nb === Infinity) return -1;
        else cmp = na - nb;
      } else if (k === "name") { cmp = a.name.localeCompare(b.name); }
      else { const oa = POS_ORDER[a.position] || 99, ob = POS_ORDER[b.position] || 99; cmp = oa - ob; if (cmp === 0) cmp = a.name.localeCompare(b.name); }
      return cmp * dir;
    });
    if (!rows.length) { root.innerHTML = '<p class="empty">No players to show.</p>'; return; }
    const arrow = key => overviewSort.key === key ? (overviewSort.dir === 1 ? " ▲" : " ▼") : "";
    let html = '<table><thead><tr>' +
      '<th class="sortable" data-sort="num">#' + arrow("num") + '</th>' +
      '<th class="sortable" data-sort="name">Player' + arrow("name") + '</th>' +
      '<th class="sortable" data-sort="position">Position (court spot)' + arrow("position") + '</th>' +
      '<th>Assigned drills</th></tr></thead><tbody>';
    rows.forEach(function (p) {
      const pos = p.position ? '<span class="posbadge">' + esc(posLabel(p.position)) + "</span>" : '<span class="posbadge none">—</span>';
      const ds = p.drills.length ? p.drills.map(esc).join("<br>") : '<span class="muted">none</span>';
      html += "<tr><td>" + (p.num ? "#" + esc(p.num) : "") + "</td><td>" + esc(p.name) + "</td><td>" + pos + "</td><td>" + ds + "</td></tr>";
    });
    html += "</tbody></table>";
    root.innerHTML = html;
    root.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        const key = th.getAttribute("data-sort");
        if (overviewSort.key === key) overviewSort.dir *= -1; else overviewSort = { key: key, dir: 1 };
        renderOverview();
      });
    });
  }

  // ---- import ----
  function matchPosition(raw) {
    if (!raw) return "";
    const s = raw.toLowerCase();
    const has = (...w) => w.every(x => s.indexOf(x) >= 0);
    const leftSig = has("left") || s.indexOf("zone 5") >= 0 || s.indexOf("back-left") >= 0;
    const rightSig = has("right") && !has("right side");
    const zone1 = s.indexOf("zone 1") >= 0 || s.indexOf("back-right") >= 0;
    if (has("defensive") || /\bds\b/.test(s)) {
      if (leftSig) return "Defensive Specialist – Left";
      if (rightSig || zone1) return "Defensive Specialist – Right";
      return "Defensive Specialist – Left";
    }
    if (has("libero")) return "Libero";
    if (has("setter")) return "Setter / Opposite";
    if (has("opposite") || has("right side")) return "Setter / Opposite";
    if (has("middle") || has("blocker")) return "Middle Blocker";
    if (has("outside") || has("hitter")) return "Outside Hitter";
    return "";
  }

  async function onImport() {
    const text = document.getElementById("importText").value;
    const replace = document.getElementById("importReplace").checked;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setImportResult("Nothing to import — paste some rows first.", true); return; }

    const parsed = []; const skipped = [];
    lines.forEach(function (line, i) {
      if (/^(name|player)\b/i.test(line) && !/\d/.test(line)) { skipped.push("Line " + (i + 1) + ": header — skipped"); return; }
      const tokens = line.replace(/\s*,\s*/g, " ").replace(/\t+/g, " ").trim().split(/\s+/);
      const numIdx = tokens.findIndex(t => /^\d{1,2}$/.test(t));
      let name = "", num = "", posRaw = "";
      if (numIdx > 0) { name = tokens.slice(0, numIdx).join(" "); num = tokens[numIdx]; posRaw = tokens.slice(numIdx + 1).join(" "); }
      else if (numIdx === 0) { num = tokens[0]; name = tokens[1] || ""; posRaw = tokens.slice(2).join(" "); }
      else { name = tokens[0]; posRaw = tokens.slice(1).join(" "); }
      const position = matchPosition(posRaw);
      if (!name) { skipped.push("Line " + (i + 1) + ": no name"); return; }
      if (posRaw && !position) { skipped.push("Line " + (i + 1) + ' (' + name + '): position "' + posRaw + '" not recognized'); }
      parsed.push({ id: uid(), name: name, num: num, position: position, drills: [] });
    });
    if (!parsed.length) { setImportResult("No valid players found. " + skipped.join("; "), true); return; }

    try {
      if (cloud) {
        setStatus("saving…");
        if (replace) { // delete all current, then insert
          for (const p of players) { await cloudDelete(p.id); }
        }
        const rows = parsed.map((p, i) => ({ name: p.name, num: p.num, position: p.position, drills: [], sort_order: (replace ? 0 : players.length) + i }));
        const { error } = await sb.from("players").insert(rows);
        if (error) throw error;
        await reloadPlayers();
      } else {
        if (replace) players = parsed; else players = players.concat(parsed);
        saveLocalPlayers();
      }
      renderRoster();
      let msg = "Imported " + parsed.length + " player" + (parsed.length === 1 ? "" : "s") + (replace ? " (replaced roster)." : " (appended).");
      if (skipped.length) msg += " ⚠ " + skipped.length + " note(s): " + skipped.join("; ");
      setImportResult(msg, skipped.length > 0);
      document.getElementById("importText").value = "";
      // hide migrate box if it was showing (we now have cloud data)
      const mb = document.getElementById("migrateBox"); if (mb) mb.style.display = "none";
    } catch (err) {
      setImportResult("Import failed: " + err.message, true);
    }
  }

  function setImportResult(msg, warn) {
    const el = document.getElementById("importResult");
    el.textContent = msg;
    el.style.color = warn ? "var(--warn)" : "var(--good)";
  }

  function onExport() {
    const lines = ["Volley Squad — Team Export", "Generated " + new Date().toLocaleString(), ""];
    players.forEach(function (p) {
      lines.push((p.num ? "#" + p.num + " " : "") + p.name + " — " + (p.position ? posLabel(p.position) : "no position"));
      if (p.drills.length) p.drills.forEach(d => lines.push("   • " + d));
      lines.push("");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "volley-squad-" + new Date().toISOString().slice(0, 10) + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ============================================================
  //  PLAYER SELF-SELECT VIEW
  // ============================================================
  async function initPlayer() {
    document.getElementById("coachApp").style.display = "none";
    document.getElementById("playerApp").style.display = "";

    // Player-view tab switching (Pick your position / Drills to practice).
    document.querySelectorAll('#playerTabs .tab').forEach(function (t) {
      t.addEventListener("click", function () {
        const which = t.getAttribute("data-ptab");
        document.querySelectorAll('#playerTabs .tab').forEach(x => x.classList.remove("active"));
        t.classList.add("active");
        document.getElementById("ptab-pick").style.display = which === "pick" ? "" : "none";
        document.getElementById("ptab-drills").style.display = which === "drills" ? "" : "none";
      });
    });

    if (!cloud) {
      document.getElementById("playerSelfEmpty").textContent =
        "This link needs the cloud to be set up. Ask your coach.";
      return;
    }

    // If no stored passcode, prompt for it before loading anything.
    if (!getPass()) { showPassPrompt(); return; }
    await loadPlayerRoster();
  }

  function showPassPrompt(wrong) {
    // Render the passcode box at the TOP (#playerGate) and hide the court/roster until unlocked.
    document.getElementById("playerContent").style.display = "none";
    const gate = document.getElementById("playerGate");
    gate.innerHTML =
      '<h2 style="margin-top:4px">Enter the team passcode</h2>' +
      '<p class="hint">Your coach shared this code with the team. Enter it to pick your position.</p>' +
      '<div class="pcard" style="max-width:380px">' +
      (wrong ? '<div class="saveflash" style="color:var(--bad);margin-bottom:6px">Incorrect passcode — try again.</div>' : '') +
      '<div class="row"><input id="passInput" type="text" autofocus placeholder="team passcode" ' +
      'style="flex:1;padding:12px 14px;border:1px solid var(--line);border-radius:9px;font-size:16px"> ' +
      '<button id="passGo" class="primary">Enter</button></div>' +
      '</div>';
    const go = async function () {
      const v = document.getElementById("passInput").value.trim();
      if (!v) return;
      rebuildClientWithPass(v);
      // Verify with a READ (players can read but NOT insert under the two-role rules).
      // Correct code returns roster rows; wrong code returns [] (RLS blocks it).
      try {
        const { data, error } = await sb.from("players").select("id").limit(1);
        if (error) throw error;
        if (!data || data.length === 0) { showPassPrompt(true); return; }
        setPass(v);
        gate.innerHTML = "";                                     // clear the prompt
        document.getElementById("playerContent").style.display = ""; // reveal court + roster
        players = await cloudFetch();
        try { drills = await cloudLoadDrills(); } catch (e) {}   // load drills so players see them
        renderPlayerSelf();
      } catch (e) {
        showPassPrompt(true);
      }
    };
    document.getElementById("passGo").addEventListener("click", go);
    const inp = document.getElementById("passInput");
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    inp.focus();
  }

  async function loadPlayerRoster() {
    // Already have a stored passcode → reveal content and load.
    document.getElementById("playerGate").innerHTML = "";
    document.getElementById("playerContent").style.display = "";
    try {
      players = await cloudFetch();
      try { drills = await cloudLoadDrills(); } catch (e) {}   // load drills so players see them
      renderPlayerSelf();
    } catch (e) {
      showPassPrompt(true);
    }
  }

  function renderPlayerSelf() {
    // Drills-tab court stays a plain names-court with tappable zones.
    const dr = document.getElementById("courtWrapDrills");
    if (dr) dr.innerHTML = buildCourtWithNames();
    wireDrillCourt();           // make the Drills-tab court zones tappable
    document.getElementById("playerTabs").style.display = "";

    // Pick tab = drag-and-drop court + an "unassigned" tray.
    renderPickDnD();
  }

  // --- Drag-and-drop pick view -------------------------------------------------
  // Each player gets a draggable name chip. Drag a chip onto a court zone to pick
  // (or change) that spot; drag it to the "Not placed yet" tray to clear it.
  // Dropping saves via the same cloudUpdate() path the dropdown used.
  function renderPickDnD() {
    const empty = document.getElementById("playerSelfEmpty");
    const wrap = document.getElementById("courtWrapPick");
    const list = document.getElementById("playerSelfList");
    if (!wrap || !list) return;

    if (!players.length) {
      wrap.innerHTML = "";
      list.innerHTML = "";
      if (empty) { empty.style.display = "block"; empty.textContent = "No players on the roster yet."; }
      return;
    }
    if (empty) empty.style.display = "none";

    // group players by canonical position
    const byZone = {};
    players.forEach(function (p) {
      const z = canonPosition(p.position);
      if (!z) return;
      (byZone[z] = byZone[z] || []).push(p);
    });
    const sortByNameNum = (a, b) => {
      const na = a.num ? parseInt(a.num, 10) : Infinity, nb = b.num ? parseInt(b.num, 10) : Infinity;
      if (na !== nb) return na - nb;
      return a.name.localeCompare(b.name);
    };

    // Build the court with draggable chips inside each zone (drop targets).
    const cells = COURT_ZONES.map(function (z) {
      const roster = (byZone[z.pos] || []).slice().sort(sortByNameNum);
      const chips = roster.map(chipHTML).join("");
      return '<div class="zone dropzone' + (roster.length ? ' has' : '') + '" data-pos="' + esc(z.pos) + '">' +
        '<span class="zn">' + z.zn + '</span>' +
        '<span class="zl">' + z.zl + '</span>' +
        '<span class="zc">' + z.zc + '</span>' +
        '<div class="courtnames">' + chips + '</div></div>';
    }).join("");
    wrap.innerHTML =
      '<div class="courtnet">◤ NET ◥</div>' +
      '<div class="court court-named court-dnd">' + cells + '</div>' +
      '<div class="courtcap muted small">Drag your name onto your spot · drag back to the tray to clear</div>';

    // Unassigned tray.
    const unplaced = players.filter(p => !canonPosition(p.position)).sort(sortByNameNum);
    list.innerHTML =
      '<div class="trayhead">Not placed yet <span class="muted small">(drag your name to the court)</span></div>' +
      '<div class="tray dropzone" data-pos="">' +
      (unplaced.length ? unplaced.map(chipHTML).join("") : '<span class="muted small traytip">Everyone has a spot 🎉</span>') +
      '</div>';

    wireDnD();
  }

  function chipHTML(p) {
    // Player view only — no jersey number here (numbers are coach-only, shown on the
    // coach Roster + Team Overview table). Chips show the name only.
    return '<span class="chip" draggable="false" data-id="' + esc(p.id) + '">' + esc(p.name) + '</span>';
  }

  // Pointer-based drag (works for touch AND mouse — native HTML5 DnD does not fire
  // on mobile touch, which is where the team actually uses this).
  let dnd = null;
  function wireDnD() {
    const pick = document.getElementById("ptab-pick");
    if (!pick) return;
    pick.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("pointerdown", onChipDown);
    });
  }

  function dropzones() { return Array.prototype.slice.call(document.querySelectorAll("#ptab-pick .dropzone")); }

  function onChipDown(e) {
    if (e.button != null && e.button !== 0) return; // left / primary only
    const chip = e.currentTarget;
    const id = chip.getAttribute("data-id");
    e.preventDefault();

    const rect = chip.getBoundingClientRect();
    const ghost = chip.cloneNode(true);
    ghost.classList.add("chip-ghost");
    ghost.style.width = rect.width + "px";
    document.body.appendChild(ghost);
    chip.classList.add("chip-dragging");

    dnd = {
      id: id,
      chip: chip,
      ghost: ghost,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      overZone: null,
      moved: false,
    };
    moveGhost(e.clientX, e.clientY);

    try { chip.setPointerCapture(e.pointerId); } catch (x) {}
    chip.addEventListener("pointermove", onChipMove);
    chip.addEventListener("pointerup", onChipUp);
    chip.addEventListener("pointercancel", onChipUp);
  }

  function moveGhost(x, y) {
    if (!dnd) return;
    dnd.ghost.style.left = (x - dnd.offX) + "px";
    dnd.ghost.style.top = (y - dnd.offY) + "px";
  }

  function zoneAtPoint(x, y) {
    if (dnd) dnd.ghost.style.visibility = "hidden";
    const el = document.elementFromPoint(x, y);
    if (dnd) dnd.ghost.style.visibility = "";
    if (!el) return null;
    return el.closest(".dropzone");
  }

  function onChipMove(e) {
    if (!dnd) return;
    dnd.moved = true;
    moveGhost(e.clientX, e.clientY);
    const zone = zoneAtPoint(e.clientX, e.clientY);
    if (zone !== dnd.overZone) {
      if (dnd.overZone) dnd.overZone.classList.remove("dropover");
      dnd.overZone = zone;
      if (zone) zone.classList.add("dropover");
    }
  }

  async function onChipUp(e) {
    if (!dnd) return;
    const d = dnd;
    dnd = null;
    d.chip.removeEventListener("pointermove", onChipMove);
    d.chip.removeEventListener("pointerup", onChipUp);
    d.chip.removeEventListener("pointercancel", onChipUp);
    d.chip.classList.remove("chip-dragging");
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    if (d.overZone) d.overZone.classList.remove("dropover");

    const zone = d.overZone;
    if (!zone) return;                    // dropped outside any target → no-op
    const newPos = zone.getAttribute("data-pos") || "";   // "" = unassigned tray
    await savePlayerPosition(d.id, newPos);
  }

  // Persist a drag drop (same cloud path the dropdown used), then re-render.
  async function savePlayerPosition(id, newPos) {
    const p = players.find(x => x.id === id);
    if (!p) return;
    const prev = p.position;
    if (canonPosition(prev) === canonPosition(newPos)) { renderPickDnD(); return; } // no real change
    p.position = newPos;
    try {
      await cloudUpdate(p.id, { position: newPos });
      renderPickDnD();
      highlightCourt(newPos);
      flashCourtSaved(p.name, newPos);
    } catch (e) {
      p.position = prev;
      renderPickDnD();
      const msg = document.getElementById("playerSyncMsg");
      if (msg) { msg.textContent = "Save failed — try again."; msg.style.color = "var(--bad)"; }
    }
  }

  function flashCourtSaved(name, pos) {
    const msg = document.getElementById("playerSyncMsg");
    if (!msg) return;
    msg.textContent = pos ? (name + " → " + posLabel(canonPosition(pos)) + " · saved ✓") : (name + " cleared · saved ✓");
    msg.style.color = "var(--good)";
    clearTimeout(msg._t);
    msg._t = setTimeout(function () { msg.textContent = ""; }, 2800);
  }

  // Make the Drills-tab court zones tappable → show that position's drills below.
  function wireDrillCourt() {
    const dr = document.getElementById("courtWrapDrills");
    if (!dr) return;
    dr.querySelectorAll(".zone").forEach(function (z) {
      z.style.cursor = "pointer";
      z.addEventListener("click", function () {
        const pos = z.getAttribute("data-pos"); // note: Opposite maps into the Setter/Zone-2 box
        dr.querySelectorAll(".zone").forEach(x => x.classList.remove("lit"));
        z.classList.add("lit");
        showDrillPanel(pos);
      });
    });
  }

  function showDrillPanel(zonePos) {
    const panel = document.getElementById("drillPanel");
    if (!panel) return;
    const key = canonPosition(zonePos);
    let html = "";
    const common = drills[COMMON_KEY] || [];
    if (common.length) {
      html += '<div class="poslib poslib-common"><h3>' + esc(COMMON_LABEL) + "</h3>" +
        '<ul class="drill-list">' + common.map(d => "<li>" + esc(d) + "</li>").join("") + "</ul></div>";
    }
    const ds = drills[key] || [];
    html += '<div class="poslib"><h3>' + esc(posLabel(key)) + "</h3>";
    if (!ds.length) html += '<p class="muted small">No drills set for this position yet.</p>';
    else html += '<ul class="drill-list">' + ds.map(d => "<li>" + esc(d) + "</li>").join("") + "</ul>";
    html += "</div>";
    panel.innerHTML = html;
  }

  // Court zone definitions (must match the static court markup order/labels).
  const COURT_ZONES = [
    { pos: "Outside Hitter",               zn: "4", zl: "Outside Hitter",       zc: "front-left" },
    { pos: "Middle Blocker",               zn: "3", zl: "Middle Blocker",       zc: "front-center" },
    { pos: "Setter / Opposite",            zn: "2", zl: "Setter / Opposite",    zc: "front-right" },
    { pos: "Defensive Specialist – Left",  zn: "5", zl: "Defensive Specialist", zc: "back-left" },
    { pos: "Libero",                       zn: "6", zl: "Libero",               zc: "back-center" },
    { pos: "Defensive Specialist – Right", zn: "1", zl: "Defensive Specialist", zc: "back-right" },
  ];

  // Build the court HTML with each player's NAME placed in their chosen zone (live from `players`).
  function buildCourtWithNames() {
    // group player names by the zone their position maps to
    const byZone = {};
    players.forEach(function (p) {
      if (!p.position) return;
      const z = canonPosition(p.position);
      (byZone[z] = byZone[z] || []).push(p.name);
    });
    let cells = COURT_ZONES.map(function (z) {
      const names = (byZone[z.pos] || []).slice().sort((a, b) => a.localeCompare(b));
      const chips = names.length
        ? '<div class="courtnames">' + names.map(n => '<span class="cname">' + esc(n) + '</span>').join("") + '</div>'
        : '<div class="courtnames empty-z">—</div>';
      return '<div class="zone' + (names.length ? ' has' : '') + '" data-pos="' + esc(z.pos) + '">' +
        '<span class="zn">' + z.zn + '</span>' +
        '<span class="zl">' + z.zl + '</span>' +
        '<span class="zc">' + z.zc + '</span>' + chips + '</div>';
    }).join("");
    return '<div class="courtnet">◤ NET ◥</div>' +
      '<div class="court court-named">' + cells + '</div>' +
      '<div class="courtcap muted small">Standard court · net at top · players shown in their chosen spot</div>';
  }

  function renderCoachCourt() {
    const el = document.getElementById("coachCourt");
    if (el) el.innerHTML = buildCourtWithNames();
  }

  function highlightCourt(positionKey) {
    // Highlight the chosen zone on the Pick-tab court (the one with the roster selectors).
    const wrap = document.getElementById("courtWrapPick");
    const court = wrap ? wrap.querySelector(".court") : null;
    if (!court) return;
    const target = canonPosition(positionKey);
    court.querySelectorAll(".zone").forEach(function (z) {
      z.classList.toggle("lit", z.getAttribute("data-pos") === target && !!target);
    });
  }

  function flashSaved(card, text, err) {
    let n = card.querySelector(".saveflash");
    if (!n) { n = document.createElement("div"); n.className = "saveflash"; card.appendChild(n); }
    n.textContent = text;
    n.style.color = err ? "var(--bad)" : "var(--good)";
    clearTimeout(n._t);
    n._t = setTimeout(function () { n.textContent = ""; }, 2500);
  }

  // ============================================================
  //  BOOT
  // ============================================================
  // Stamp the visible build label in the footer(s) so you can confirm the live version.
  (function stampBuild() {
    ["buildTag", "buildTagPlayer"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.textContent = "· build " + BUILD;
    });
  })();

  if (isPlayerView) initPlayer(); else initCoach();
})();
