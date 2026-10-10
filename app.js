/* Volleyball Coach — Phase 1 (coach-entered, localStorage) */
(function () {
  "use strict";

  const STORE_KEY = "vbcoach.v1";

  // Standard volleyball positions
  const POSITIONS = [
    "Setter",
    "Outside Hitter",
    "Opposite / Right Side",
    "Middle Blocker",
    "Libero",
    "Defensive Specialist",
  ];

  // Default drill library, mapped by position. Coach can edit freely.
  const DEFAULT_DRILLS = {
    "Setter": ["Setting footwork ladder", "Hand positioning / soft hands", "Back-set accuracy", "Jump-set reps", "Setter–hitter tempo timing"],
    "Outside Hitter": ["Approach footwork (4-step)", "High-ball swing timing", "Cross-court vs line hitting", "Serve-receive platform", "Tooling the block"],
    "Opposite / Right Side": ["Right-side approach timing", "Back-row attack (pipe/D)", "Blocking the OH", "Slide attack", "Transition footwork"],
    "Middle Blocker": ["Blocking footwork (swing block)", "Quick-attack (tempo 1)", "Read-blocking the setter", "Lateral shuffle + close", "Slide timing"],
    "Libero": ["Platform passing reps", "Digging hard-driven balls", "Pepper (control)", "Serve-receive movement", "Emergency / pursuit"],
    "Defensive Specialist": ["Serve-receive passing", "Reading the hitter", "Low-posture digging", "Court coverage movement", "Short-serve recovery"],
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
        o.value = pos; o.textContent = pos;
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
    lbl.textContent = p.position ? ("Assign drills · " + p.position) : "Pick a position to see drills";
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
      h.textContent = pos;
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
      o.value = pos; o.textContent = pos;
      sel.appendChild(o);
    });
    sel.value = cur;
  }
  document.getElementById("filterPos").addEventListener("change", renderOverview);

  function renderOverview() {
    const root = document.getElementById("overviewTable");
    const filter = document.getElementById("filterPos").value;
    const rows = state.players.filter(p => !filter || p.position === filter);
    if (!rows.length) {
      root.innerHTML = '<p class="empty">No players to show.</p>';
      return;
    }
    let html = "<table><thead><tr><th>#</th><th>Player</th><th>Position</th><th>Assigned drills</th></tr></thead><tbody>";
    rows.forEach(function (p) {
      const pos = p.position
        ? '<span class="posbadge">' + esc(p.position) + "</span>"
        : '<span class="posbadge none">—</span>';
      const drills = p.drills.length ? p.drills.map(esc).join("<br>") : '<span class="muted">none</span>';
      html += "<tr><td>" + (p.num ? "#" + esc(p.num) : "") + "</td><td>" + esc(p.name) +
        "</td><td>" + pos + "</td><td>" + drills + "</td></tr>";
    });
    html += "</tbody></table>";
    root.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- export ----
  document.getElementById("exportBtn").addEventListener("click", function () {
    const lines = ["Volley Squad — Team Export", "Generated " + new Date().toLocaleString(), ""];
    state.players.forEach(function (p) {
      lines.push((p.num ? "#" + p.num + " " : "") + p.name + " — " + (p.position || "no position"));
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
