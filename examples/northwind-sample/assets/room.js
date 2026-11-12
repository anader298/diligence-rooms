// Diligence room: one script for the index, person landings, pages and the one card.
// Reading progress lives in this browser only (localStorage), keyed by room.
(function () {
  "use strict";
  var body = document.body;
  var room = body.dataset.room || "room";
  var KEY = "dr:" + room + ":read";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  // ---------- read state ----------
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
      // A demo room may seed progress so the first screen shows the feature.
      if (body.dataset.demoRead) return body.dataset.demoRead.split(/\s+/).filter(Boolean);
    } catch (e) {}
    return [];
  }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
  var read = load();
  var isRead = function (id) { return read.indexOf(id) > -1; };
  function setRead(id, on) {
    read = read.filter(function (x) { return x !== id; });
    if (on) read.push(id);
    save(read);
    paint();
  }

  function paint() {
    // every element that stands for a page
    $$("[data-page-id]").forEach(function (el) { el.classList.toggle("is-read", isRead(el.dataset.pageId)); });
    // overall progress
    var total = +(body.dataset.pages || 0);
    if (total) {
      var n = read.length > total ? total : read.length;
      $$(".prog").forEach(function (p) {
        p.style.setProperty("--pct", Math.round((n / total) * 100) + "%");
        var t = $(".t", p); if (t) t.innerHTML = n + " of " + total + '<span class="lg"> read</span>';
      });
    }
    // per chapter and per person counts
    $$("[data-read-of]").forEach(function (el) {
      var ids = el.dataset.readOf.split(/\s+/), n = ids.filter(isRead).length;
      el.textContent = n + "/" + ids.length;
      var link = el.closest("a"); if (link) link.classList.toggle("all-read", n === ids.length);
    });
    var btn = $(".readbtn");
    if (btn) {
      var on = isRead(btn.dataset.pageId);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = on ? "Read" : "Mark as read";
    }
  }

  var btn = $(".readbtn");
  if (btn) {
    btn.addEventListener("click", function () { setRead(btn.dataset.pageId, !isRead(btn.dataset.pageId)); });
    // Reaching the end of the page counts as reading it.
    var end = $(".endcap");
    if (end && "IntersectionObserver" in window) {
      var seen = false, t0 = Date.now();
      new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting && !seen && Date.now() - t0 > 4000) { seen = true; setRead(btn.dataset.pageId, true); }
        });
      }).observe(end);
    }
  }
  paint();

  // ---------- countdown and deadlines ----------
  // "2026-03-05" or "2026-03-05T10:00" is read as local time (the room's own clock), anything else by Date.
  function parse(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(v);
  }
  var now = body.dataset.now ? parse(body.dataset.now) : new Date();
  var started = Date.now();
  function current() { return new Date(now.getTime() + (Date.now() - started)); }
  function parts(ms) {
    var m = Math.max(0, Math.floor(ms / 60000));
    return { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60), m: m % 60 };
  }
  function rel(ms) {
    var p = parts(Math.abs(ms)), s;
    if (p.d >= 2) s = p.d + " days";
    else if (p.d === 1) s = "1 day " + p.h + " h";
    else if (p.h >= 1) s = p.h + " h " + p.m + " min";
    else s = p.m + " min";
    return ms >= 0 ? "in " + s : s + " ago";
  }
  function tick() {
    var t = current();
    // The first meeting still ahead becomes the headline; past ones step back.
    var meetings = $$("[data-meeting]"), shown = false;
    meetings.forEach(function (el) {
      var when = parse(el.dataset.meeting), ahead = when - t > -60 * 60000;
      el.classList.toggle("hide", !ahead || shown);
      if (ahead && !shown) {
        shown = true;
        var p = parts(when - t), c = $(".count", el);
        if (c) {
          $(".cd", c).textContent = p.d; $(".ch", c).textContent = p.h; $(".cm", c).textContent = p.m;
          $(".cd + small", c).textContent = p.d === 1 ? "day" : "days";
          $(".ch + small", c).textContent = p.h === 1 ? "hour" : "hours";
          c.setAttribute("aria-label", "Starts " + rel(when - t));
        }
      }
    });
    $$("[data-due]").forEach(function (el) {
      var due = parse(el.dataset.due), ms = due - t;
      el.classList.toggle("past", ms < 0);
      el.classList.toggle("soon", ms >= 0 && ms < 3 * 86400000);
      var r = $(".rel", el); if (r) r.textContent = ms < 0 ? "Passed" : "Due " + rel(ms);
    });
    $$("[data-until]").forEach(function (el) {
      var ms = parse(el.dataset.until) - t;
      el.textContent = ms > 0 ? "Starts " + rel(ms) : "Started " + rel(ms);
    });
  }
  if ($("[data-meeting], [data-due], [data-until]")) { tick(); setInterval(tick, 30000); }

  // ---------- search (index) ----------
  var q = $("#q"), mq = $("#mq");
  var items = $$(".item"), secs = $$("details.sec, details.grp"), hits = $("#hits"), wasOpen = null;
  function apply(src) {
    var s = src.value.trim().toLowerCase(), terms = s.split(/\s+/).filter(Boolean), active = terms.length > 0;
    [q, mq].forEach(function (i) { if (i && i !== src) i.value = src.value; if (i) i.parentNode.classList.toggle("on", !!s); });
    if (active && wasOpen === null) wasOpen = secs.map(function (d) { return d.open; });
    var n = 0;
    items.forEach(function (it) {
      var ok = terms.every(function (t) { return (it.dataset.s || "").indexOf(t) > -1; });
      it.classList.toggle("hide", active && !ok);
      if (ok && active) n++;
    });
    secs.forEach(function (sec, i) {
      var v = $$(".item:not(.hide)", sec).length;
      sec.classList.toggle("hide", active && v === 0);
      if (active) sec.open = v > 0; else if (wasOpen) sec.open = wasOpen[i];
    });
    $$("[data-hide-on-search]").forEach(function (el) { el.classList.toggle("hide", active); });
    if (hits) hits.textContent = active ? (n ? n + " page" + (n === 1 ? "" : "s") + " match “" + src.value.trim() + "”" : "No page mentions “" + src.value.trim() + "”. Try one word, or a name.") : "";
    if (!active) wasOpen = null;
  }
  [q, mq].forEach(function (i) {
    if (!i) return;
    i.addEventListener("input", function () { apply(i); });
    var c = i.parentNode.querySelector("button");
    if (c) c.addEventListener("click", function () { i.value = ""; apply(i); i.focus(); });
  });
  document.addEventListener("keydown", function (e) {
    var tag = (document.activeElement || {}).tagName;
    if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
      var target = q && q.offsetParent ? q : mq;
      if (target) { e.preventDefault(); target.focus(); }
    }
    if (e.key === "Escape" && (document.activeElement === q || document.activeElement === mq) && document.activeElement.value) {
      document.activeElement.value = ""; apply(document.activeElement);
    }
  });

  var xall = $("#xall"), call = $("#call");
  if (xall) xall.addEventListener("click", function () { secs.forEach(function (d) { d.open = true; }); });
  if (call) call.addEventListener("click", function () { secs.forEach(function (d) { d.open = false; }); });

  // ---------- scroll spy: rail on the index, jump bar on pages ----------
  function spy(links) {
    if (!links.length) return;
    var targets = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
    function hl() {
      var y = window.scrollY + 140, cur = 0;
      targets.forEach(function (t, i) { if (t && t.getBoundingClientRect().top + window.scrollY <= y) cur = i; });
      links.forEach(function (a, i) {
        var on = i === cur;
        a.classList.toggle("cur", on);
        if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
      });
      var nav = links[cur].closest("nav.jumps");
      if (nav && nav.scrollWidth > nav.clientWidth) {
        var a = links[cur], l = a.offsetLeft - 20;
        if (l < nav.scrollLeft || a.offsetLeft + a.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = l;
      }
    }
    window.addEventListener("scroll", hl, { passive: true });
    hl();
  }
  var railLinks = $$('.rail a[href^="#"]');
  railLinks.forEach(function (a) {
    a.addEventListener("click", function () {
      var d = document.getElementById(a.getAttribute("href").slice(1));
      for (var e = d; e; e = e.parentElement) if (e.tagName === "DETAILS") e.open = true;
    });
  });
  spy(railLinks);
  spy($$('nav.jumps a[href^="#"]'));

  // ---------- tables: label every cell so rows can stack on a phone ----------
  $$(".tw").forEach(function (tw) {
    var table = $("table", tw); if (!table) return;
    var head = table.tHead ? table.tHead.rows[0] : table.rows[0];
    if (!head || !$("th", head)) return;
    var labels = [].map.call(head.cells, function (c) { return c.textContent.trim(); });
    [].forEach.call(table.rows, function (r) {
      if (r === head) return;
      [].forEach.call(r.cells, function (c, i) { if (labels[i] && !c.hasAttribute("data-label")) c.setAttribute("data-label", labels[i]); });
    });
    if (labels.length > 1) tw.classList.add("stack");
  });

  // ---------- print: open every chapter ----------
  window.addEventListener("beforeprint", function () { secs.forEach(function (d) { d.dataset.wasOpen = d.open ? "1" : ""; d.open = true; }); });
  window.addEventListener("afterprint", function () { secs.forEach(function (d) { d.open = !!d.dataset.wasOpen; }); });
})();

// ---------- round two: Feed it, filterable lists, practice dashboard ----------
(function () {
  "use strict";
  var body = document.body, room = body.dataset.room || "room";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem("dr:" + room + ":" + k) || "null"); localStorage.setItem("dr:" + room + ":" + k, JSON.stringify(v)); } catch (e) { return null; } }

  // ----- Feed it -----
  var dlg = $("#feed");
  function feedPaint() {
    var items = store("feed") || [];
    $$(".fb-n").forEach(function (b) { b.hidden = !items.length; b.textContent = items.length; });
    $$(".fb-count").forEach(function (b) { b.textContent = items.length ? items.length + " saved so far." : ""; });
    var list = $("#feedlist");
    if (list) list.innerHTML = items.slice().reverse().map(function (it) { return "<li><b>" + esc(it.kind) + "</b>" + esc(it.text).slice(0, 160) + "</li>"; }).join("");
  }
  if (dlg) {
    $$("[data-open-feed]").forEach(function (b) { b.addEventListener("click", function () { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); var t = $("textarea", dlg); if (t) t.focus(); }); });
    $("#feedsave").addEventListener("click", function (e) {
      var f = dlg.querySelector("form"), text = f.text.value.trim();
      if (!text) { e.preventDefault(); $("#feedstatus").textContent = "Write a note first."; f.text.focus(); return; }
      var items = store("feed") || [];
      items.push({ kind: f.kind.value, text: text, src: f.src.value.trim(), page: location.pathname.split("/").pop() || "index.html", at: new Date().toISOString() });
      store("feed", items); f.text.value = ""; f.src.value = "";
      e.preventDefault(); $("#feedstatus").textContent = "Saved. " + items.length + " note" + (items.length === 1 ? "" : "s") + " waiting for the next rebuild."; feedPaint();
    });
    $("#feedcopy").addEventListener("click", function () {
      var txt = JSON.stringify(store("feed") || [], null, 2);
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(function () { $("#feedstatus").textContent = "Copied. Paste it to the room builder."; },
        function () { $("#feedstatus").textContent = "Copy failed. Select the list and copy it by hand."; });
    });
    feedPaint();
  }

  // ----- filterable lists: documents, glossary, roster -----
  var RENDER = {
    docs: function (d) {
      return '<div class="r"><a href="' + esc(d.u) + '">' + esc(d.t) + '</a><span class="ty">' + esc(d.ty) + '</span><span class="yr">' + d.y + '</span>' +
        '<span class="note">' + esc(d.n) + '</span><span class="tags">' + (d.sf ? '<span class="tg sf">Study first</span>' : "") + d.tp.map(function (t) { return '<span class="tg">' + esc(t) + "</span>"; }).join("") + "</span></div>";
    },
    terms: function (d) {
      var warn = /^(Never|Do not)/.test(d.n || "");
      return '<div class="r"><b>' + esc(d.a) + '</b><span class="m">' + esc(d.m) + '</span><span class="ours">' + (d.b ? "We say: " + esc(d.b) : "") + "</span>" +
        (d.n ? '<span class="say' + (warn ? " warn" : "") + '">' + esc(d.n) + "</span>" : "") + "</div>";
    },
    people: function (d) {
      var ini = d.n.split(" ").map(function (x) { return x[0]; }).join("").slice(0, 2);
      var nm = d.h ? '<a href="' + esc(d.h) + '">' + esc(d.n) + "</a>" : "<b>" + esc(d.n) + "</b>";
      return '<div class="r"><span class="mono" aria-hidden="true">' + ini + '</span><span class="nmt">' + nm + "<span>" + esc(d.t) + ", since " + d.y + '</span></span><span class="where">' + esc(d.f) + " · " + esc(d.l) + '</span><span class="touch k-' + d.k.toLowerCase().replace(/[^a-z]+/g, "-") + '">' + esc(d.k) + "</span>" +
        (d.x ? '<span class="note">' + esc(d.x) + "</span>" : "") + "</div>";
    }
  };
  var CLOSE = ["In the meeting", "Signs", "Gatekeeper", "Influences", "Told", "Will use it", "Affected", "None"];
  $$("[data-list]").forEach(function (root) {
    var kind = root.dataset.list, data = JSON.parse($("[data-json]", root).textContent);
    if (kind === "terms") data.forEach(function (d) { d.warn = /^(Never|Do not)/.test(d.n || ""); });
    var facets = (root.dataset.facets || "").split(",").filter(Boolean).map(function (f) { var p = f.split(":"); return { key: p[0], label: p[1] }; });
    var flag = root.dataset.flag ? { key: root.dataset.flag.split(":")[0], label: root.dataset.flag.split(":")[1] } : null;
    var on = {}, flagOn = false, q = $("[data-q]", root), sortSel = $("[data-sort]", root), rows = $("[data-rows]", root), count = $("[data-count]", root);
    var host = $("[data-facet-host]", root);
    facets.forEach(function (f) {
      on[f.key] = [];
      var vals = {};
      data.forEach(function (d) { [].concat(d[f.key]).forEach(function (v) { vals[v] = (vals[v] || 0) + 1; }); });
      var keys = Object.keys(vals);
      if (f.key === "k") keys.sort(function (a, b) { return CLOSE.indexOf(a) - CLOSE.indexOf(b); }); else keys.sort();
      var div = document.createElement("div"); div.className = "facet"; div.setAttribute("role", "group"); div.setAttribute("aria-label", f.label);
      div.innerHTML = '<span class="fl">' + esc(f.label) + "</span>" + keys.map(function (v) { return '<button type="button" class="chip-b" aria-pressed="false" data-k="' + f.key + '" data-v="' + esc(v) + '">' + esc(v) + '<span class="n">' + vals[v] + "</span></button>"; }).join("");
      host.appendChild(div);
    });
    if (flag) {
      var n = data.filter(function (d) { return d[flag.key]; }).length;
      var div = document.createElement("div"); div.className = "facet";
      div.innerHTML = '<span class="fl">Show</span><button type="button" class="chip-b flag" aria-pressed="false" data-flag>' + esc(flag.label) + ' only<span class="n">' + n + "</span></button>";
      host.insertBefore(div, host.firstChild);
    }
    host.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var pressed = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", pressed);
      if (b.hasAttribute("data-flag")) flagOn = pressed;
      else { var k = b.dataset.k, v = b.dataset.v; on[k] = pressed ? on[k].concat(v) : on[k].filter(function (x) { return x !== v; }); }
      draw();
    });
    function draw() {
      var s = q ? q.value.trim().toLowerCase() : "", terms = s.split(/\s+/).filter(Boolean);
      if (q) q.parentNode.classList.toggle("on", !!s);
      var out = data.filter(function (d) {
        if (flagOn && !d[flag.key]) return false;
        for (var k in on) if (on[k].length && ![].concat(d[k]).some(function (v) { return on[k].indexOf(v) > -1; })) return false;
        if (terms.length) { var hay = JSON.stringify(d).toLowerCase(); return terms.every(function (t) { return hay.indexOf(t) > -1; }); }
        return true;
      });
      var so = sortSel ? sortSel.value : "";
      if (so === "y-") out.sort(function (a, b) { return b.y - a.y; });
      else if (so === "y+") out.sort(function (a, b) { return a.y - b.y; });
      else if (so === "t") out.sort(function (a, b) { return a.t.localeCompare(b.t); });
      else if (so === "n") out.sort(function (a, b) { return a.n.localeCompare(b.n); });
      else if (so === "k") out.sort(function (a, b) { return CLOSE.indexOf(a.k) - CLOSE.indexOf(b.k); });
      var head = kind === "terms" ? '<div class="r head"><span>They say</span><span>It means</span><span>We would say</span></div>' : "";
      rows.innerHTML = out.length ? head + out.map(RENDER[kind]).join("") : '<p class="empty">Nothing matches. Clear a filter or try one word.</p>';
      var active = flagOn || terms.length || Object.keys(on).some(function (k) { return on[k].length; });
      count.innerHTML = "Showing " + out.length + " of " + data.length + (active ? ' <button type="button" data-reset>Clear filters</button>' : "");
    }
    count.addEventListener("click", function (e) {
      if (!e.target.closest("[data-reset]")) return;
      flagOn = false; for (var k in on) on[k] = []; if (q) q.value = "";
      $$("button[aria-pressed]", host).forEach(function (b) { b.setAttribute("aria-pressed", "false"); }); draw();
    });
    if (q) { q.addEventListener("input", draw); var c = q.parentNode.querySelector("button"); if (c) c.addEventListener("click", function () { q.value = ""; draw(); q.focus(); }); }
    if (sortSel) sortSel.addEventListener("change", draw);
    draw();
  });

  // ----- practice dashboard -----
  var pd = $("#practice-data");
  if (!pd) return;
  var P = JSON.parse(pd.textContent);

  // tabs
  var tabs = $$('[role="tab"]'), panels = $$('[role="tabpanel"]');
  function show(i, focus) {
    tabs.forEach(function (t, j) { t.setAttribute("aria-selected", i === j); t.tabIndex = i === j ? 0 : -1; panels[j].hidden = i !== j; });
    if (focus) tabs[i].focus();
    history.replaceState(null, "", "#" + panels[i].dataset.hash);
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { show(i); });
    t.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") show((i + 1) % tabs.length, true);
      if (e.key === "ArrowLeft") show((i - 1 + tabs.length) % tabs.length, true);
    });
  });
  var h = location.hash.slice(1);
  panels.forEach(function (p, i) { if (p.dataset.hash === h) show(i); });

  // pitch clock
  var beats = P.beats, total = beats.reduce(function (a, b) { return a + b[1]; }, 0) * 60;
  var running = false, startAt = 0, acc = 0, beat = 0, beatStart = 0, timer = null;
  var face = $(".clock-face"), bl = $("#clk-beats");
  function fmt(s) { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function elapsed() { return acc + (running ? (Date.now() - startAt) / 1000 : 0); }
  function drawBeats(el) {
    var used = el - beatStart, lim = beats[beat][1] * 60;
    bl.innerHTML = beats.map(function (b, i) {
      var cls = i < beat ? "done" : i === beat ? "cur" + (used > lim ? " late" : "") : "";
      var t = i === beat ? fmt(used) + " / " + b[1] + ":00" : b[1] + " min";
      return '<li class="' + cls + '"><span>' + esc(b[0]) + '</span><span class="bt">' + t + "</span></li>";
    }).join("");
    face.classList.toggle("warn", used > lim - 60 && used <= lim);
    face.classList.toggle("over", used > lim || el > total);
    $("#clk-beat").textContent = (running ? "Now: " : el ? "Paused: " : "Ready: ") + beats[beat][0];
    $("#clk-time").textContent = fmt(used);
    $("#clk-sub").textContent = el > total ? fmt(el - total) + " over the hour" : fmt(total - el) + " left in the meeting";
  }
  function tick() { drawBeats(elapsed()); }
  function go() {
    if (running) { acc = elapsed(); running = false; clearInterval(timer); $("#clk-go").textContent = "Resume"; }
    else { startAt = Date.now(); running = true; timer = setInterval(tick, 250); $("#clk-go").textContent = "Pause"; }
    tick();
  }
  function next() { if (beat < beats.length - 1) { beat++; beatStart = elapsed(); tick(); } }
  $("#clk-go").addEventListener("click", go);
  $("#clk-next").addEventListener("click", next);
  $("#clk-reset").addEventListener("click", function () { running = false; clearInterval(timer); acc = 0; beat = 0; beatStart = 0; $("#clk-go").textContent = "Start"; tick(); });
  document.addEventListener("keydown", function (e) {
    if ($("#p-clock").hidden || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
    if (e.key === " ") { e.preventDefault(); go(); } if (e.key === "n" || e.key === "N") next();
  });
  tick();

  // scorecard
  var crit = P.crit, cur = store("score-cur") || crit.map(function () { return null; });
  var cl = $("#sc-crit");
  $("#sc-max").textContent = crit.length * 2;
  cl.innerHTML = crit.map(function (c, i) {
    return '<li><span class="who">' + esc(c[0]) + '</span><span><b>' + esc(c[1]) + '</b><span class="d">' + esc(c[2]) + '</span></span><span class="pts" role="group" aria-label="' + esc(c[1]) + ' score">' +
      [0, 1, 2].map(function (v) { return '<button type="button" data-i="' + i + '" data-v="' + v + '" aria-pressed="false" aria-label="' + ["Missed", "Partly", "Hit"][v] + '">' + v + "</button>"; }).join("") + "</span></li>";
  }).join("");
  function scorePaint() {
    $$("button", cl).forEach(function (b) { b.setAttribute("aria-pressed", cur[+b.dataset.i] === +b.dataset.v); });
    $("#sc-n").textContent = cur.reduce(function (a, v) { return a + (v || 0); }, 0);
    var hist = store("score-hist") || [];
    $("#sc-hist").innerHTML = hist.length ? hist.slice(-6).reverse().map(function (r) { return "<li>" + r.d + ": " + r.s + " of " + r.m + "</li>"; }).join("") : "<li>No runs saved yet.</li>";
    var sp = $("#sc-spark"), H = hist.slice(-10);
    if (H.length) {
      var pts = H.map(function (r, i) { return [10 + (H.length === 1 ? 140 : i * 280 / (H.length - 1)), 62 - (r.s / r.m) * 54]; });
      sp.innerHTML = '<polyline points="' + pts.map(function (p) { return p.join(","); }).join(" ") + '"/>' + pts.map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3"/>'; }).join("");
      sp.setAttribute("aria-label", "Scores of the last " + H.length + " runs: " + H.map(function (r) { return r.s; }).join(", "));
    } else sp.innerHTML = "";
  }
  cl.addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; cur[+b.dataset.i] = +b.dataset.v; store("score-cur", cur); scorePaint(); });
  $("#sc-save").addEventListener("click", function () {
    var hist = store("score-hist") || [], d = new Date();
    hist.push({ d: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), s: cur.reduce(function (a, v) { return a + (v || 0); }, 0), m: crit.length * 2 });
    store("score-hist", hist); cur = crit.map(function () { return null; }); store("score-cur", cur); scorePaint();
  });
  $("#sc-clear").addEventListener("click", function () { cur = crit.map(function () { return null; }); store("score-cur", cur); scorePaint(); });
  if (!store("score-hist") && body.dataset.demoRead) store("score-hist", [{ d: "1 Mar 20:10", s: 9, m: 18 }, { d: "2 Mar 07:30", s: 12, m: 18 }, { d: "2 Mar 21:00", s: 14, m: 18 }]);
  scorePaint();

  // flashcards
  var deck = P.cards.map(function (c, i) { return i; }), pos = 0, flipped = false, known = store("cards-known") || [];
  function cardPaint() {
    var left = deck.filter(function (i) { return known.indexOf(i) < 0; });
    if (!left.length) { known = []; store("cards-known", known); left = deck.slice(); }
    if (pos >= left.length) pos = 0;
    var c = P.cards[left[pos]];
    $("#fc-front").textContent = c.a;
    $("#fc-back").innerHTML = "<span>" + esc(c.m) + "</span>" + (c.b ? '<span class="ours">We would say: ' + esc(c.b) + "</span>" : "") + (c.n ? '<span class="say">' + esc(c.n) + "</span>" : "");
    $("#fc-back").hidden = !flipped; $("#fc-front").hidden = flipped;
    $("#fc-meta").textContent = (known.length) + " of " + P.cards.length + " known · card " + (pos + 1) + " of " + left.length + " left";
    return left;
  }
  $("#fc-card").addEventListener("click", function () { flipped = !flipped; cardPaint(); });
  $("#fc-got").addEventListener("click", function () { var left = cardPaint(); known.push(left[pos]); store("cards-known", known); flipped = false; cardPaint(); });
  $("#fc-again").addEventListener("click", function () { pos++; flipped = false; cardPaint(); });
  $("#fc-shuffle").addEventListener("click", function () { for (var i = deck.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = deck[i]; deck[i] = deck[j]; deck[j] = t; } pos = 0; flipped = false; cardPaint(); });
  cardPaint();

  // objections and push-backs
  var pl = $("#pb-list"), onlyNew = $("#pb-new");
  function pbPaint() {
    var list = P.push.filter(function (p) { return !onlyNew.checked || p[2]; });
    $("#pb-count").textContent = list.length + " push-backs, " + P.push.filter(function (p) { return p[2]; }).length + " carry a new fact";
    pl.innerHTML = list.map(function (p, i) {
      return '<li><p class="who">' + esc(p[0]) + (p[2] ? ' <span class="newfact">New fact</span>' : "") + '</p><p class="q">“' + esc(p[1]) + '”</p>' +
        '<button type="button" class="btn reveal" aria-expanded="false" aria-controls="pa' + i + '">Show the model answer</button>' +
        '<div class="ans" id="pa' + i + '" hidden><p>' + esc(p[3]) + "</p><small>" + esc(p[4]) + "</small></div></li>";
    }).join("");
  }
  pl.addEventListener("click", function (e) {
    var b = e.target.closest(".reveal"); if (!b) return;
    var a = document.getElementById(b.getAttribute("aria-controls")), open = b.getAttribute("aria-expanded") !== "true";
    a.hidden = !open; b.setAttribute("aria-expanded", open); b.textContent = open ? "Hide the answer" : "Show the model answer";
  });
  onlyNew.addEventListener("change", pbPaint);
  pbPaint();

  // mock meetings: one turn at a time, answer first in your head, then reveal
  var mk = 0, step = 0, shown = false, ini = { Dan: "DE", Theo: "TL", Ines: "IC", Ruth: "RO", Legal: "LF" };
  $("#mk-pick").innerHTML = P.mocks.map(function (m, i) { return '<button type="button" aria-pressed="' + (i === 0) + '" data-m="' + i + '"><b>' + esc(m[0]) + "</b><span>" + esc(m[1]) + "</span></button>"; }).join("");
  $("#mk-pick").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; mk = +b.dataset.m; step = 0; shown = false; $$("#mk-pick button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); }); mkPaint(); });
  function mkPaint() {
    var m = P.mocks[mk], turns = m[2], run = $("#mk-run");
    if (step >= turns.length) {
      run.innerHTML = '<div class="prog-l">' + turns.map(function () { return '<i class="on"></i>'; }).join("") + '</div><p class="turn says">Done. Score the run on the scorecard while it is fresh.</p><div class="acts"><a class="btn solid" href="#score" data-tab="1">Open the scorecard</a><button type="button" class="btn" data-restart>Run it again</button></div>';
      return;
    }
    var t = turns[step];
    run.innerHTML = '<div class="prog-l" aria-label="Turn ' + (step + 1) + " of " + turns.length + '">' + turns.map(function (x, i) { return '<i class="' + (i <= step ? "on" : "") + '"></i>'; }).join("") + "</div>" +
      '<div class="turn"><span class="mono" aria-hidden="true">' + (ini[t[0]] || t[0][0]) + '</span><div><p class="who">' + esc(t[0]) + '</p><p class="says">“' + esc(t[1]) + '”</p></div></div>' +
      (shown ? '<div class="ans"><p>' + esc(t[2]) + "</p><small>Listen for: " + esc(t[3]) + "</small></div>" : '<p class="yours">Answer out loud first, then reveal.</p>') +
      '<div class="acts">' + (shown ? '<button type="button" class="btn solid" data-next>Next turn</button>' : '<button type="button" class="btn solid" data-show>Reveal the answer</button>') + '<button type="button" class="btn" data-restart>Start over</button></div>';
  }
  $("#mk-run").addEventListener("click", function (e) {
    if (e.target.closest("[data-show]")) { shown = true; mkPaint(); $("#mk-run [data-next]").focus(); }
    else if (e.target.closest("[data-next]")) { step++; shown = false; mkPaint(); var s = $("#mk-run [data-show]"); if (s) s.focus(); }
    else if (e.target.closest("[data-restart]")) { step = 0; shown = false; mkPaint(); }
    else if (e.target.closest("[data-tab]")) { e.preventDefault(); show(1, true); }
  });
  mkPaint();
})();

// ---------- org chart: start centred on the leadership, fit toggle, edge cue ----------
(function () {
  [].forEach.call(document.querySelectorAll(".orgscroll"), function (sc) {
    var fx = +sc.dataset.focusX || 0;
    sc.scrollLeft = fx;
    function edge() { sc.classList.toggle("at-end", sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 4); }
    sc.addEventListener("scroll", edge, { passive: true }); edge();
    var btn = sc.parentNode.querySelector("[data-org-fit]");
    if (btn) btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", on); btn.textContent = on ? "Actual size" : "Fit to screen";
      sc.classList.toggle("fit", on); if (!on) sc.scrollLeft = fx; edge();
    });
  });
})();
