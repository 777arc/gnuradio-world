// Diagnostics panel for the WASM flowgraph runner.
//
// Linked as an Emscripten --post-js, so it runs in the Module scope and
// survives Qt's regeneration of runner.html. It builds a collapsible status bar
// pinned to the bottom of the page and polls the C++ gr_stats_json() export at
// ~3 Hz, deriving throughput / realtime factor / CPU share / bottleneck from
// successive snapshots and mixing in browser + Emscripten host metrics.
(function () {
  'use strict';

  // This post-js is also bundled into every pthread Web Worker, where there is
  // no DOM and no ccall. Touching document there throws and aborts the whole
  // runtime, so bail out on anything that isn't the main browser thread.
  if (typeof importScripts === 'function' || typeof document === 'undefined' ||
      typeof window === 'undefined') return;

  var POLL_MS = 333;         // ~3 Hz
  var HIST = 48;             // sparkline history length
  var SMOOTH = 6;            // samples averaged for throughput/cpu (~2 s window)
  var SPARK = '▁▂▃▄▅▆▇█';

  var series = {};           // name -> [{t, items, work} ...] smoothing window
  var hist = {};             // name -> [throughput ...] for the sparkline
  var fps = 0, frames = 0, fpsT = performance.now();
  var jank = 0;              // long-tasks per second (rolling)
  var jankCount = 0, jankT = performance.now();
  var expanded = false;
  var el = {};               // cached DOM nodes
  var workerTracker = null;  // prewarmed tier + cumulative dynamic allocations

  // PThread is Emscripten's closure-local worker-pool object. It is deliberately
  // read directly here rather than through Module.PThread, which this Qt build
  // does not export. Install the wrapper lazily on the first diagnostics tick:
  // by then the configured pool has been prewarmed, and any workers the graph
  // managed to add before that tick are visible in the two pool arrays.
  function workerCount() {
    return PThread.unusedWorkers.length + PThread.runningWorkers.length;
  }
  function installWorkerTracker(prewarmed) {
    if (workerTracker || typeof PThread === 'undefined') return;
    var allocated = workerCount();
    workerTracker = {
      prewarmed: prewarmed,
      additionalCreated: Math.max(0, allocated - prewarmed),
      active: PThread.runningWorkers.length,
      allocated: allocated
    };
    var allocateUnusedWorker = PThread.allocateUnusedWorker;
    PThread.allocateUnusedWorker = function () {
      var before = workerCount();
      var result = allocateUnusedWorker.apply(PThread, arguments);
      var after = workerCount();
      // Workers deliberately added to reach a corrected tier are still
      // prewarmed capacity, not scheduler-created extras. runner.cpp brackets
      // that asynchronous preload with this global flag.
      if (after > before && !globalThis.__grTierPreloading)
        workerTracker.additionalCreated += after - before;
      return result;
    };
    window.__grWorkerStats = workerTracker;
  }
  function readWorkerStats(prewarmed) {
    try {
      installWorkerTracker(prewarmed);
      if (!workerTracker) return null;
      workerTracker.active = PThread.runningWorkers.length;
      workerTracker.allocated = workerCount();
      return workerTracker;
    } catch (e) {
      return null;
    }
  }

  function spark(arr, lo, hi) {
    if (!arr || !arr.length) return '';
    if (hi <= lo) hi = lo + 1;
    var s = '';
    for (var i = 0; i < arr.length; i++) {
      var f = (arr[i] - lo) / (hi - lo);
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      s += SPARK[Math.round(f * (SPARK.length - 1))];
    }
    return s;
  }
  function eng(x) { // 12000 -> "12.0k"
    if (!isFinite(x)) return '--';
    var a = Math.abs(x);
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'G';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(1) + 'k';
    return x.toFixed(0);
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(0); }

  // ---- host metrics -------------------------------------------------------
  function rafLoop() {
    frames++;
    var now = performance.now();
    if (now - fpsT >= 1000) { fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
    requestAnimationFrame(rafLoop);
  }
  function installJankObserver() {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      new PerformanceObserver(function (list) { jankCount += list.getEntries().length; })
        .observe({ entryTypes: ['longtask'] });
    } catch (e) { /* longtask unsupported */ }
  }
  // ---- GR stats snapshot --------------------------------------------------
  // Pushed onto window.__grstats by the C++ side (main-thread QTimer), because
  // Qt's build drops Emscripten's ccall/cwrap so we can't call into C from here.
  function readStats() {
    try { return window.__grstats ? JSON.parse(window.__grstats) : null; }
    catch (e) { return null; }
  }

  // ---- DOM ---------------------------------------------------------------
  function build() {
    var css = document.createElement('style');
    css.textContent =
      '#gr-diag{position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#d6deeb;' +
      'background:rgba(16,20,28,.94);border-top:1px solid #2b3547;' +
      'box-shadow:0 -2px 8px rgba(0,0,0,.4)}' +
      '#gr-diag .bar{display:flex;align-items:center;gap:14px;padding:5px 10px;cursor:pointer;white-space:nowrap;overflow-x:auto}' +
      '#gr-diag .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}' +
      '#gr-diag .k{color:#8a97ad}' +
      '#gr-diag .grow{flex:1}' +
      '#gr-diag .btn{color:#8a97ad;border:1px solid #2b3547;border-radius:3px;padding:1px 7px}' +
      '#gr-diag table{width:100%;border-collapse:collapse;font-size:11px}' +
      '#gr-diag .body{max-height:40vh;overflow:auto;padding:0 10px 8px;display:none}' +
      '#gr-diag.open .body{display:block}' +
      '#gr-diag th{color:#8a97ad;text-align:right;font-weight:400;padding:3px 8px;position:sticky;top:0;background:#141a24}' +
      '#gr-diag th.l,#gr-diag td.l{text-align:left}' +
      '#gr-diag td{text-align:right;padding:2px 8px;border-top:1px solid #1e2632}' +
      '#gr-diag tr.hot td{background:rgba(224,74,74,.16)}' +
      '#gr-diag .spk{color:#5aa9e6;letter-spacing:-1px}';
    document.head.appendChild(css);

    var root = document.createElement('div');
    root.id = 'gr-diag';
    root.innerHTML =
      '<div class="bar">' +
        '<span class="dot" id="d-dot"></span>' +
        '<span id="d-rt"><span class="k">realtime</span> --</span>' +
        '<span id="d-cpu"><span class="k">cpu</span> --</span>' +
        '<span id="d-mem"><span class="k">wasm</span> --</span>' +
        '<span id="d-fps"><span class="k">fps</span> --</span>' +
        '<span id="d-tier"><span class="k">tier</span> --</span>' +
        '<span id="d-workers"><span class="k">active workers</span> --</span>' +
        '<span id="d-thr"><span class="k">dsp threads</span> --</span>' +
        '<span id="d-jank"><span class="k">jank</span> --</span>' +
        '<span id="d-bot" class="grow"><span class="k">bottleneck</span> --</span>' +
        '<span class="btn" id="d-btn">metrics ▲</span>' +
      '</div>' +
      '<div class="body"><table><thead><tr>' +
        '<th class="l">block</th><th class="l">type</th><th>items/s</th>' +
        '<th>work µs</th><th>cpu%</th><th>in■</th><th>out■</th><th class="l">throughput</th>' +
      '</tr></thead><tbody id="d-rows"></tbody></table></div>';
    document.body.appendChild(root);

    el.root = root;
    ['d-dot','d-rt','d-cpu','d-mem','d-fps','d-tier','d-workers','d-thr','d-jank','d-bot','d-rows'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    var bar = root.querySelector('.bar');
    bar.addEventListener('click', function () {
      expanded = !expanded;
      root.classList.toggle('open', expanded);
      document.getElementById('d-btn').textContent = expanded ? 'metrics ▼' : 'metrics ▲';
    });

    // Keep the bar out of the flowgraph's way. It is fixed to the bottom of the
    // page, and the Qt window fills the page (frameless and full screen, see
    // runner.cpp), so a bar drawn over it covers the bottom of whatever the GUI
    // Layout block put on that row. Shrink the *container element* instead: Qt
    // takes its QScreen geometry from it, and keeps a full-screen window matched
    // to that, so the flowgraph gets the whole page minus this strip and nothing
    // overlaps. Measured rather than hardcoded because the height is whatever
    // the bar's font and padding come to. Only the collapsed bar is subtracted:
    // the expanded metrics table is a transient panel to read, and taking a
    // third of the window away from a running flowgraph to show it -- resizing
    // every plot in the process -- would be worse than covering it.
    var screenEl = document.getElementById('screen');
    var applyInset = function () {
      var height = bar.offsetHeight;
      if (screenEl && height) screenEl.style.height = 'calc(100% - ' + height + 'px)';
    };
    applyInset();
    if (typeof ResizeObserver !== 'undefined')
      new ResizeObserver(applyInset).observe(bar);
  }

  // ---- update loop -------------------------------------------------------
  function tick() {
    var now = performance.now();
    if (now - jankT >= 1000) { jank = jankCount * 1000 / (now - jankT); jankCount = 0; jankT = now; }

    var st = readStats();
    var rows = [], sumCpu = 0, botName = '--', botCpu = -1, refThru = NaN;

    if (st && st.blocks) {
      for (var i = 0; i < st.blocks.length; i++) {
        var b = st.blocks[i];
        // A throttle's work() sleeps to pace the graph; that sleep lands in its
        // work-time, so its "cpu" is bogus and it must not be a bottleneck.
        var isThr = /throttle/.test(b.id);

        // Smooth throughput/cpu over a short window: sources such as a throttle
        // produce in bursts larger than one poll, so single-poll diffs alias.
        var s = series[b.name] || (series[b.name] = []);
        s.push({ t: now, items: Number(b.items), work: b.work_total_s });
        if (s.length > SMOOTH) s.shift();
        var o = s[0], c = s[s.length - 1], dt = (c.t - o.t) / 1000;
        var thru = NaN, cpu = 0;
        if (dt > 0.1) { thru = (c.items - o.items) / dt; cpu = (c.work - o.work) / dt * 100; }

        if (!isThr && isFinite(cpu) && cpu > 0) sumCpu += cpu;
        if (!isThr && cpu > botCpu) { botCpu = cpu; botName = b.name; }
        if (b.ref && isFinite(thru)) refThru = thru;

        var h = hist[b.name] || (hist[b.name] = []);
        if (isFinite(thru)) { h.push(thru); if (h.length > HIST) h.shift(); }
        rows.push({ b: b, thru: thru, cpu: cpu, isThr: isThr, hist: h });
      }
      if (botCpu < 1) botName = 'none';
    }

    // headline: realtime factor at the reference block
    var rt = (isFinite(refThru) && st && st.ref_samp_rate > 0) ? refThru / st.ref_samp_rate : NaN;
    var color = !isFinite(rt) ? '#8a97ad' : rt >= 0.98 ? '#54d18c' : rt >= 0.8 ? '#e0b34a' : '#e04a4a';
    el['d-dot'].style.background = color;
    el['d-rt'].innerHTML = '<span class="k">realtime</span> ' +
      (isFinite(rt) ? rt.toFixed(2) + '×' : '--');
    el['d-rt'].style.color = color;

    var cores = navigator.hardwareConcurrency || '?';
    el['d-cpu'].innerHTML = '<span class="k">cpu</span> ' + Math.round(sumCpu) + '% <span class="k">/' + cores + 'c</span>';
    el['d-mem'].innerHTML = '<span class="k">wasm</span> ' + (st ? mb(st.wasm_heap) : '--') + 'MB';
    el['d-fps'].innerHTML = '<span class="k">fps</span> ' + Math.round(fps);
    var workers = st ? readWorkerStats(st.pool) : null;
    el['d-tier'].innerHTML = '<span class="k">tier</span> ' +
      (st ? st.pool + (workers ? ' +' + workers.additionalCreated + ' extra' : '') : '--');
    el['d-workers'].innerHTML = '<span class="k">active workers</span> ' +
      (workers ? workers.active : '--');
    el['d-thr'].innerHTML = '<span class="k">dsp threads</span> ' +
      (st ? st.dsp_threads : '--');
    el['d-jank'].innerHTML = '<span class="k">jank</span> ' + jank.toFixed(0) + '/s';
    el['d-bot'].innerHTML = '<span class="k">bottleneck</span> ' + botName +
      (botCpu > 0 ? ' (' + Math.round(botCpu) + '%)' : '');

    if (expanded) {
      var out = '';
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r], bb = row.b;
        var hot = bb.in_full > 0.8 || bb.out_full > 0.8;
        var lo = Math.min.apply(null, row.hist), hi = Math.max.apply(null, row.hist);
        var type = bb.id.replace(/_x+$/, '').replace(/^[a-z]+_/, '');
        out += '<tr class="' + (hot ? 'hot' : '') + '">' +
          '<td class="l">' + bb.name + '</td>' +
          '<td class="l k">' + type + '</td>' +
          '<td>' + eng(row.thru) + '</td>' +
          '<td>' + (row.isThr ? '<span class="k">sleep</span>' : bb.work_us.toFixed(1)) + '</td>' +
          '<td>' + (row.isThr ? '<span class="k">·</span>' : Math.round(row.cpu)) + '</td>' +
          '<td>' + Math.round(bb.in_full * 100) + '</td>' +
          '<td>' + Math.round(bb.out_full * 100) + '</td>' +
          '<td class="l spk">' + spark(row.hist, lo, hi) + '</td>' +
          '</tr>';
      }
      el['d-rows'].innerHTML = out || '<tr><td class="l k" colspan="8">waiting for flowgraph…</td></tr>';
    }
  }

  // ---- boot: wait until the DOM is ready ---------------------------------
  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    build();
    installJankObserver();
    requestAnimationFrame(rafLoop);
    setInterval(tick, POLL_MS);
  }
  setTimeout(boot, 300);
})();
