/* Volleyball Coach — Phase 1 (coach-entered, localStorage) */
(function () {
  "use strict";

  const STORE_KEY = "vbcoach.v1";

  // Standard volleyball positions. `key` = stored value (stable, don't change);
  // `label` = friendly display (role + court spot); `zone` = official FIVB zone (service=1);
  // `order` = court-reading order for the overview: front row L→R (4,3,2) then back row (5,6,1).
  const POSITION_DEFS = [
    { key: "Outside Hitter",         label: "Outside Hitter (front-left · Zone 4)",            zone: 4, order: 1 },
    { key: "Middle Blocker",         label: "Middle Blocker (front-center · Zone 3)",          zone: 3, order: 2 },
    { key: "Setter",                 label: "Setter (front-right · Zone 2)",                   zone: 2, order: 3 },
    { key: "Opposite / Right Side",  label: "Opposite / Right Side (front-right · Zone 2)",    zone: 2, order: 4 },
    { key: "Defensive Specialist – Left",  label: "Defensive Specialist – Left (back-left · Zone 5)",  zone: 5, order: 5 },
    { key: "Libero",                 label: "Libero (back-center · Zone 6)",                   zone: 6, order: 6 },
    { key: "Defensive Specialist – Right", label: "Defensive Specialist – Right (back-right · Zone 1)", zone: 1, order: 7 },
  ];
  // Keep POSITIONS (keys) for existing data/drill-library compatibility, in court-reading order.
  const POSITIONS = POSITION_DEFS.map(p => p.key);
  const POS_LABEL = {}; const POS_ORDER = {};
  POSITION_DEFS.forEach(p => { POS_LABEL[p.key] = p.label; POS_ORDER[p.key] = p.order; });
  function posLabel(key) { return POS_LABEL[key] || key; }

  // Default drill library, mapped by position. Coach can edit freely.
  const DEFAULT_DRILLS = {
    "Setter": ["Setting footwork ladder", "Hand positioning / soft hands", "Back-set accuracy", "Jump-set reps", "Setter–hitter tempo timing"],
    "Outside Hitter": ["Approach footwork (4-step)", "High-ball swing timing", "Cross-court vs line hitting", "Serve-receive platform", "Tooling the block"],
    "Opposite / Right Side": ["Right-side approach timing", "Back-row attack (pipe/D)", "Blocking the OH", "Slide attack", "Transition footwork"],
    "Middle Blocker": ["Blocking footwork (swing block)", "Quick-attack (tempo 1)", "Read-blocking the setter", "Lateral shuffle + close", "Slide timing"],
    "Libero": ["Platform passing reps", "Digging hard-driven balls", "Pepper (control)", "Serve-receive movement", "Emergency / pursuit"],
    "Defensive Specialist – Left": ["Serve-receive passing (Zone 5)", "Reading the hitter", "Low-posture digging", "Court coverage (left back)", "Short-serve recovery"],
    "Defensive Specialist – Right": ["Serve-receive passing (Zone 1)", "Reading the hitter", "Low-posture digging", "Court coverage (right back)", "Serve from Zone 1"],
  };

  // ---- state ----
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { players: [], drills: structuredCloneSafe(DEFAULT_DRILLS) };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---- tabs ----
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

  // ---- import roster (paste) ----
  // Loosely match a free-text position to a POSITION key.
  function matchPosition(raw) {
    if (!raw) return "";
    const s = raw.toLowerCase();
    const has = (...w) => w.every(x => s.indexOf(x) >= 0);
    // Read left/right/zone signals from the FULL string (incl. any parenthetical) FIRST.
    const leftSig  = has("left")  || s.indexOf("zone 5") >= 0 || s.indexOf("back-left") >= 0;
    const rightSig = has("right") && !has("right side"); // "right side" = Opposite, not DS-right
    const zone1    = s.indexOf("zone 1") >= 0 || s.indexOf("back-right") >= 0;
    if (has("defensive") || /\bds\b/.test(s)) {
      if (leftSig) return "Defensive Specialist – Left";
      if (rightSig || zone1) return "Defensive Specialist – Right";
      return "Defensive Specialist – Left"; // bare DS -> left by default
    }
    if (has("libero")) return "Libero";
    if (has("setter")) return "Setter";
    if (has("opposite") || has("right side")) return "Opposite / Right Side";
    if (has("middle") || has("blocker")) return "Middle Blocker";
    if (has("outside") || has("hitter")) return "Outside Hitter";
    return ""; // unmatched
  }

  document.getElementById("importBtn").addEventListener("click", function () {
    const text = document.getElementById("importText").value;
    const replace = document.getElementById("importReplace").checked;
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) { setImportResult("Nothing to import — paste some rows first.", true); return; }

    const parsed = []; const skipped = [];
    lines.forEach(function (line, i) {
      // Skip a header row like "Name Number Position" (no number token + contains header words).
      if (/^(name|player)\b/i.test(line) && !/\d/.test(line)) {
        skipped.push("Line " + (i + 1) + ": looks like a header — skipped");
        return;
      }
      // Normalize separators: commas/tabs/multi-space → single space, then split on spaces.
      const tokens = line.replace(/\s*,\s*/g, " ").replace(/\t+/g, " ").trim().split(/\s+/);
      // The number = first standalone 1–2 digit token. Name = tokens before it; position = tokens after.
      const numIdx = tokens.findIndex(t => /^\d{1,2}$/.test(t));
      let name = "", num = "", posRaw = "";
      if (numIdx > 0) {
        name = tokens.slice(0, numIdx).join(" ");
        num = tokens[numIdx];
        posRaw = tokens.slice(numIdx + 1).join(" ");
      } else if (numIdx === 0) {
        // number first (unusual): num, then rest is "name position" — ambiguous; treat first word as name
        num = tokens[0]; name = tokens[1] || ""; posRaw = tokens.slice(2).join(" ");
      } else {
        // no number: first token name, rest position
        name = tokens[0]; posRaw = tokens.slice(1).join(" ");
      }
      const position = matchPosition(posRaw);
      if (!name) { skipped.push("Line " + (i + 1) + ": no name"); return; }
      if (posRaw && !position) { skipped.push("Line " + (i + 1) + ' (' + name + '): position "' + posRaw + '" not recognized — added with no position'); }
      parsed.push({ id: uid(), name: name, num: num, position: position, drills: [] });
    });

    if (!parsed.length) { setImportResult("No valid players found. " + skipped.join("; "), true); return; }

    if (replace) state.players = parsed;
    else state.players = state.players.concat(parsed);
    save();
    renderRoster();

    let msg = "Imported " + parsed.length + " player" + (parsed.length === 1 ? "" : "s") +
      (replace ? " (replaced roster)." : " (appended).");
    if (skipped.length) msg += " ⚠ " + skipped.length + " note(s): " + skipped.join("; ");
    setImportResult(msg, skipped.length > 0);
    document.getElementById("importText").value = "";
  });

  function setImportResult(msg, warn) {
    const el = document.getElementById("importResult");
    el.textContent = msg;
    el.style.color = warn ? "var(--warn)" : "var(--good)";
  }

  // ---- roster ----
  const addForm = document.getElementById("addPlayerForm");
  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = document.getElementById("playerName").value.trim();
    const num = document.getElementById("playerNum").value.trim();
    if (!name) return;
    state.players.push({ id: uid(), name: name, num: num, position: "", drills: [] });
    save();
    addForm.reset();
    renderRoster();
    document.getElementById("playerName").focus();
  });

  function renderRoster() {
    const list = document.getElementById("playerList");
    const empty = document.getElementById("rosterEmpty");
    list.innerHTML = "";
    document.getElementById("playerCount").textContent = state.players.length;
    empty.style.display = state.players.length ? "none" : "block";

    state.players.forEach(function (p) {
      const card = document.createElement("div");
      card.className = "pcard";

      // top row: jersey, name, position select, delete
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
      sel.addEventListener("change", function () {
        p.position = sel.value;
        // drop assigned drills that no longer belong to the chosen position set? keep them; coach may want cross-training.
        save();
        renderDrillAssign(p, assignWrap);
      });

      const del = document.createElement("button");
      del.className = "del";
      del.title = "Remove player";
      del.textContent = "✕";
      del.addEventListener("click", function () {
        if (confirm("Remove " + p.name + "?")) {
          state.players = state.players.filter(x => x.id !== p.id);
          save(); renderRoster();
        }
      });

      top.appendChild(jersey); top.appendChild(nm); top.appendChild(sel); top.appendChild(del);
      card.appendChild(top);

      // drill assignment area
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
    const drills = state.drills[p.position] || [];
    if (!drills.length) {
      const none = document.createElement("span");
      none.className = "chip nodrills";
      none.textContent = "No drills for this position yet — add some in Drill Library";
      chips.appendChild(none);
    }
    drills.forEach(function (d) {
      const chip = document.createElement("span");
      chip.className = "chip" + (p.drills.indexOf(d) >= 0 ? " on" : "");
      chip.textContent = d;
      chip.addEventListener("click", function () {
        const i = p.drills.indexOf(d);
        if (i >= 0) p.drills.splice(i, 1); else p.drills.push(d);
        chip.classList.toggle("on");
        save();
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
  }

  // ---- drill library ----
  function renderDrills() {
    const root = document.getElementById("drillLibrary");
    root.innerHTML = "";
    POSITIONS.forEach(function (pos) {
      const box = document.createElement("div");
      box.className = "poslib";
      const h = document.createElement("h3");
      h.textContent = posLabel(pos);
      box.appendChild(h);

      (state.drills[pos] || []).forEach(function (d, idx) {
        box.appendChild(drillRow(pos, idx));
      });

      const add = document.createElement("button");
      add.className = "addDrill";
      add.textContent = "+ add drill";
      add.addEventListener("click", function () {
        if (!state.drills[pos]) state.drills[pos] = [];
        state.drills[pos].push("New drill");
        save(); renderDrills();
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
    inp.value = state.drills[pos][idx];
    inp.addEventListener("change", function () {
      const old = state.drills[pos][idx];
      const val = inp.value.trim() || old;
      state.drills[pos][idx] = val;
      // keep any player assignments in sync (rename)
      state.players.forEach(function (p) {
        const i = p.drills.indexOf(old);
        if (i >= 0) p.drills[i] = val;
      });
      save();
    });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete drill";
    del.addEventListener("click", function () {
      const removed = state.drills[pos][idx];
      state.drills[pos].splice(idx, 1);
      state.players.forEach(function (p) {
        const i = p.drills.indexOf(removed);
        if (i >= 0) p.drills.splice(i, 1);
      });
      save(); renderDrills();
    });
    row.appendChild(inp); row.appendChild(del);
    return row;
  }

  document.getElementById("resetDrills").addEventListener("click", function () {
    if (confirm("Reset the drill library to the default set? Your custom drills will be lost (player assignments to removed drills will clear).")) {
      state.drills = structuredCloneSafe(DEFAULT_DRILLS);
      // clear assignments no longer valid
      state.players.forEach(function (p) {
        const valid = state.drills[p.position] || [];
        p.drills = p.drills.filter(d => valid.indexOf(d) >= 0);
      });
      save(); renderDrills();
    }
  });

  // ---- overview ----
  function refreshFilterOptions() {
    const sel = document.getElementById("filterPos");
    const cur = sel.value;
    sel.innerHTML = '<option value="">All positions</option>';
    POSITIONS.forEach(function (pos) {
      const o = document.createElement("option");
      o.value = pos; o.textContent = posLabel(pos);
      sel.appendChild(o);
    });
    sel.value = cur;
  }
  document.getElementById("filterPos").addEventListener("change", renderOverview);

  // Team Overview sort state: key = 'position' | 'num' | 'name'; dir = 1 (asc) / -1 (desc)
  let overviewSort = { key: "position", dir: 1 };

  function renderOverview() {
    const root = document.getElementById("overviewTable");
    const filter = document.getElementById("filterPos").value;
    const rows = state.players.filter(p => !filter || p.position === filter);

    const k = overviewSort.key, dir = overviewSort.dir;
    rows.sort(function (a, b) {
      let cmp = 0;
      if (k === "num") {
        // numeric sort; players with no number go last (regardless of dir)
        const na = a.num === "" || a.num == null ? Infinity : parseInt(a.num, 10);
        const nb = b.num === "" || b.num == null ? Infinity : parseInt(b.num, 10);
        if (na === Infinity && nb === Infinity) cmp = 0;
        else if (na === Infinity) return 1;
        else if (nb === Infinity) return -1;
        else cmp = na - nb;
      } else if (k === "name") {
        cmp = a.name.localeCompare(b.name);
      } else { // position — court-reading order; unassigned last
        const oa = POS_ORDER[a.position] || 99;
        const ob = POS_ORDER[b.position] || 99;
        cmp = oa - ob;
        if (cmp === 0) cmp = a.name.localeCompare(b.name); // tiebreak by name
      }
      return cmp * dir;
    });

    if (!rows.length) {
      root.innerHTML = '<p class="empty">No players to show.</p>';
      return;
    }

    const arrow = key => overviewSort.key === key ? (overviewSort.dir === 1 ? " ▲" : " ▼") : "";
    let html = '<table><thead><tr>' +
      '<th class="sortable" data-sort="num">#' + arrow("num") + '</th>' +
      '<th class="sortable" data-sort="name">Player' + arrow("name") + '</th>' +
      '<th class="sortable" data-sort="position">Position (court spot)' + arrow("position") + '</th>' +
      '<th>Assigned drills</th></tr></thead><tbody>';
    rows.forEach(function (p) {
      const pos = p.position
        ? '<span class="posbadge">' + esc(posLabel(p.position)) + "</span>"
        : '<span class="posbadge none">—</span>';
      const drills = p.drills.length ? p.drills.map(esc).join("<br>") : '<span class="muted">none</span>';
      html += "<tr><td>" + (p.num ? "#" + esc(p.num) : "") + "</td><td>" + esc(p.name) +
        "</td><td>" + pos + "</td><td>" + drills + "</td></tr>";
    });
    html += "</tbody></table>";
    root.innerHTML = html;

    // wire up clickable headers
    root.querySelectorAll("th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        const key = th.getAttribute("data-sort");
        if (overviewSort.key === key) overviewSort.dir *= -1;   // same column → toggle direction
        else overviewSort = { key: key, dir: 1 };               // new column → ascending
        renderOverview();
      });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- export ----
  document.getElementById("exportBtn").addEventListener("click", function () {
    const lines = ["Volley Squad — Team Export", "Generated " + new Date().toLocaleString(), ""];
    state.players.forEach(function (p) {
      lines.push((p.num ? "#" + p.num + " " : "") + p.name + " — " + (p.position ? posLabel(p.position) : "no position"));
      if (p.drills.length) p.drills.forEach(d => lines.push("   • " + d));
      lines.push("");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "volleyball-team-" + new Date().toISOString().slice(0, 10) + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.getElementById("printBtn").addEventListener("click", function () { window.print(); });

  // ---- init ----
  renderRoster();
})();
