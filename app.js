/* Volley Squad — Phase 2 (players in Supabase cloud; drills in localStorage).
 * - Coach view: manage roster + drills + overview. Players sync to the cloud.
 * - Player view (open with ?player): tap your name, pick/change your position.
 * - Falls back to LOCAL mode if Supabase isn't configured.
 */
(function () {
  "use strict";

  const DRILLS_KEY = "vbcoach.drills.v1";
  const LOCAL_PLAYERS_KEY = "vbcoach.v1"; // legacy/local roster (used for migration + offline fallback)

  // ---- positions ----
  const POSITION_DEFS = [
    { key: "Outside Hitter",         label: "Outside Hitter (front-left · Zone 4)",            zone: 4, order: 1 },
    { key: "Middle Blocker",         label: "Middle Blocker (front-center · Zone 3)",          zone: 3, order: 2 },
    { key: "Setter",                 label: "Setter (front-right · Zone 2)",                   zone: 2, order: 3 },
    { key: "Opposite / Right Side",  label: "Opposite / Right Side (front-right · Zone 2)",    zone: 2, order: 4 },
    { key: "Defensive Specialist – Left",  label: "Defensive Specialist – Left (back-left · Zone 5)",  zone: 5, order: 5 },
    { key: "Libero",                 label: "Libero (back-center · Zone 6)",                   zone: 6, order: 6 },
    { key: "Defensive Specialist – Right", label: "Defensive Specialist – Right (back-right · Zone 1)", zone: 1, order: 7 },
  ];
  const POSITIONS = POSITION_DEFS.map(p => p.key);
  const POS_LABEL = {}; const POS_ORDER = {};
  POSITION_DEFS.forEach(p => { POS_LABEL[p.key] = p.label; POS_ORDER[p.key] = p.order; });
  function posLabel(key) { return POS_LABEL[key] || key; }

  const DEFAULT_DRILLS = {
    "Setter": ["Setting footwork ladder", "Hand positioning / soft hands", "Back-set accuracy", "Jump-set reps", "Setter–hitter tempo timing"],
    "Outside Hitter": ["Approach footwork (4-step)", "High-ball swing timing", "Cross-court vs line hitting", "Serve-receive platform", "Tooling the block"],
    "Opposite / Right Side": ["Right-side approach timing", "Back-row attack (pipe/D)", "Blocking the OH", "Slide attack", "Transition footwork"],
    "Middle Blocker": ["Blocking footwork (swing block)", "Quick-attack (tempo 1)", "Read-blocking the setter", "Lateral shuffle + close", "Slide timing"],
    "Libero": ["Platform passing reps", "Digging hard-driven balls", "Pepper (control)", "Serve-receive movement", "Emergency / pursuit"],
    "Defensive Specialist – Left": ["Serve-receive passing (Zone 5)", "Reading the hitter", "Low-posture digging", "Court coverage (left back)", "Short-serve recovery"],
    "Defensive Specialist – Right": ["Serve-receive passing (Zone 1)", "Reading the hitter", "Low-posture digging", "Court coverage (right back)", "Serve from Zone 1"],
  };

  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---- team passcode (gates all Supabase access via x-team-pass header) ----
  const PASS_KEY = "vbcoach.teampass";
  // Coach view ships with the passcode baked in (coach already has full access intent).
  // Player view prompts for it once and stores it in the browser.
  const COACH_PASS = "win2027cup";
  function getPass() {
    try { return localStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; }
  }
  function setPass(v) { try { localStorage.setItem(PASS_KEY, v); } catch (e) {} }

  // ---- Supabase client ----
  let sb = null, cloud = false;
  (function initSupabase() {
    try {
      const cfg = window.VB_SUPABASE;
      if (cfg && cfg.url && cfg.anonKey &&
          cfg.url.indexOf("YOUR_") < 0 && cfg.anonKey.indexOf("YOUR_") < 0 &&
          window.supabase && window.supabase.createClient) {
        // pass the team passcode on every request via a custom header
        const pass = /[?&]player\b/.test(location.search) ? getPass() : COACH_PASS;
        sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
          global: { headers: { "x-team-pass": pass } }
        });
        cloud = true;
      }
    } catch (e) { cloud = false; }
  })();

  // Rebuild the client with a (new) passcode — used after a player enters the code.
  function rebuildClientWithPass(pass) {
    const cfg = window.VB_SUPABASE;
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
      global: { headers: { "x-team-pass": pass } }
    });
  }

  // ---- players state ----
  let players = []; // {id, name, num, position, drills[]}
  let drills = loadDrills();

  function loadDrills() {
    try { const r = localStorage.getItem(DRILLS_KEY); if (r) return JSON.parse(r); } catch (e) {}
    return structuredCloneSafe(DEFAULT_DRILLS);
  }
  function saveDrills() { try { localStorage.setItem(DRILLS_KEY, JSON.stringify(drills)); } catch (e) {} }

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
    if (cloud) {
      setStatus("connecting…");
      await reloadPlayers();
      // show share row
      const sr = document.getElementById("shareRow"); if (sr) sr.style.display = "";
      // offer migration if cloud empty but local has players
      const local = loadLocalPlayers();
      if (players.length === 0 && local.length > 0) {
        const mb = document.getElementById("migrateBox");
        document.getElementById("migrateCount").textContent = local.length;
        if (mb) mb.style.display = "";
      }
    } else {
      setStatus("local mode (no cloud configured)");
      if (footer) footer.textContent = "Local mode — roster saved only on this device. Add Supabase keys to enable sharing.";
      players = loadLocalPlayers();
    }
    renderRoster();
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
      () => { msg.textContent = "Copied! Share this with players: " + url; },
      () => { msg.textContent = url; }
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

      const jersey = document.createElement("span");
      jersey.className = "jersey";
      jersey.textContent = p.num ? "#" + p.num : "#";

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
        renderDrillAssign(p, assignWrap);
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

      const assignWrap = document.createElement("div");
      assignWrap.className = "drillassign";
      card.appendChild(assignWrap);
      renderDrillAssign(p, assignWrap);

      list.appendChild(card);
    });

    refreshFilterOptions();
  }

  function renderDrillAssign(p, wrap) {
    wrap.innerHTML = "";
    const lbl = document.createElement("div");
    lbl.className = "lbl";
    lbl.textContent = p.position ? ("Assign drills · " + posLabel(p.position)) : "Pick a position to see drills";
    wrap.appendChild(lbl);
    if (!p.position) return;

    const chips = document.createElement("div");
    chips.className = "chips";
    const ds = drills[p.position] || [];
    if (!ds.length) {
      const none = document.createElement("span");
      none.className = "chip nodrills";
      none.textContent = "No drills for this position yet — add some in Drill Library";
      chips.appendChild(none);
    }
    ds.forEach(function (d) {
      const chip = document.createElement("span");
      chip.className = "chip" + (p.drills.indexOf(d) >= 0 ? " on" : "");
      chip.textContent = d;
      chip.addEventListener("click", async function () {
        const i = p.drills.indexOf(d);
        if (i >= 0) p.drills.splice(i, 1); else p.drills.push(d);
        chip.classList.toggle("on");
        if (cloud) { try { setStatus("saving…"); await cloudUpdate(p.id, { drills: p.drills }); setStatus("synced", "ok"); } catch (e) { setStatus("save failed", "err"); } }
        else { saveLocalPlayers(); }
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
  }

  // ---- drill library (local) ----
  function renderDrills() {
    const root = document.getElementById("drillLibrary");
    root.innerHTML = "";
    POSITIONS.forEach(function (pos) {
      const box = document.createElement("div");
      box.className = "poslib";
      const h = document.createElement("h3");
      h.textContent = posLabel(pos);
      box.appendChild(h);
      (drills[pos] || []).forEach(function (d, idx) { box.appendChild(drillRow(pos, idx)); });
      const add = document.createElement("button");
      add.className = "addDrill";
      add.textContent = "+ add drill";
      add.addEventListener("click", function () {
        if (!drills[pos]) drills[pos] = [];
        drills[pos].push("New drill");
        saveDrills(); renderDrills();
      });
      box.appendChild(add);
      root.appendChild(box);
    });
  }

  function drillRow(pos, idx) {
    const row = document.createElement("div");
    row.className = "drillrow";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = drills[pos][idx];
    inp.addEventListener("change", function () {
      const old = drills[pos][idx];
      const val = inp.value.trim() || old;
      drills[pos][idx] = val;
      saveDrills();
    });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete drill";
    del.addEventListener("click", function () {
      drills[pos].splice(idx, 1);
      saveDrills(); renderDrills();
    });
    row.appendChild(inp); row.appendChild(del);
    return row;
  }

  function onResetDrills() {
    if (confirm("Reset the drill library to the default set? Your custom drills will be lost.")) {
      drills = structuredCloneSafe(DEFAULT_DRILLS);
      saveDrills(); renderDrills();
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
    if (has("setter")) return "Setter";
    if (has("opposite") || has("right side")) return "Opposite / Right Side";
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
    const empty = document.getElementById("playerSelfEmpty");
    const list = document.getElementById("playerSelfList");
    list.innerHTML = "";
    empty.style.display = "none";
    const wrap = document.getElementById("playerSelfList");
    wrap.innerHTML =
      '<div class="pcard" style="max-width:360px">' +
      '<div class="lbl" style="margin-bottom:8px">Enter the team passcode</div>' +
      (wrong ? '<div class="saveflash" style="color:var(--bad)">Incorrect passcode — try again.</div>' : '') +
      '<div class="row"><input id="passInput" type="text" placeholder="team passcode" ' +
      'style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font-size:15px"> ' +
      '<button id="passGo" class="primary small">Enter</button></div>' +
      '<div class="muted small" style="margin-top:6px">Your coach shared this with the team.</div>' +
      '</div>';
    const go = async function () {
      const v = document.getElementById("passInput").value.trim();
      if (!v) return;
      rebuildClientWithPass(v);
      // Verify the passcode with a write-probe: insert a tiny temp row, then delete it.
      // RLS returns [] (not an error) for a wrong passcode on READS, so we can't tell
      // wrong-pass from empty-roster by reading. A write, however, 401s on a wrong passcode.
      try {
        const { data, error } = await sb.from("players")
          .insert({ name: "__passcheck__", num: "", position: "", sort_order: -999 })
          .select().single();
        if (error) throw error;              // wrong passcode → RLS rejects the insert
        await sb.from("players").delete().eq("id", data.id); // clean up the probe row
        setPass(v);
        players = await cloudFetch();
        renderPlayerSelf();
      } catch (e) {
        showPassPrompt(true);
      }
    };
    document.getElementById("passGo").addEventListener("click", go);
    document.getElementById("passInput").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }

  async function loadPlayerRoster() {
    try {
      players = await cloudFetch();
      renderPlayerSelf();
    } catch (e) {
      // stored passcode may be stale/wrong → re-prompt
      showPassPrompt(true);
    }
  }

  function renderPlayerSelf() {
    const list = document.getElementById("playerSelfList");
    const empty = document.getElementById("playerSelfEmpty");
    list.innerHTML = "";
    if (!players.length) { empty.style.display = "block"; empty.textContent = "No players on the roster yet."; return; }
    empty.style.display = "none";

    // sort by number then name for easy finding
    const sorted = players.slice().sort(function (a, b) {
      const na = a.num ? parseInt(a.num, 10) : Infinity, nb = b.num ? parseInt(b.num, 10) : Infinity;
      if (na !== nb) return na - nb;
      return a.name.localeCompare(b.name);
    });

    sorted.forEach(function (p) {
      const card = document.createElement("div");
      card.className = "pcard";
      const top = document.createElement("div");
      top.className = "ptop";

      const jersey = document.createElement("span");
      jersey.className = "jersey";
      jersey.textContent = p.num ? "#" + p.num : "#";

      const nm = document.createElement("span");
      nm.className = "pname";
      nm.textContent = p.name;

      const sel = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = "— tap to choose your spot —";
      sel.appendChild(blank);
      POSITIONS.forEach(function (pos) {
        const o = document.createElement("option");
        o.value = pos; o.textContent = posLabel(pos);
        if (p.position === pos) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", async function () {
        const prev = p.position;
        p.position = sel.value;
        const note = document.createElement("span");
        try {
          await cloudUpdate(p.id, { position: p.position });
          flashSaved(card, "Saved ✓");
        } catch (e) {
          p.position = prev; sel.value = prev;
          flashSaved(card, "Save failed — try again", true);
        }
      });

      top.appendChild(jersey); top.appendChild(nm); top.appendChild(sel);
      card.appendChild(top);
      list.appendChild(card);
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
  if (isPlayerView) initPlayer(); else initCoach();
})();
