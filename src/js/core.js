/* ==========================================================================
   LojaCerta · Core
   Utilitários, template seguro, event bus, store persistente, router,
   UI (toasts/modais), ícones SVG, validação e permissões.
   Sem dependências externas. Tudo exposto via window.*
   ========================================================================== */
;(function () {
  'use strict';

  /* ---------------- Utilitários ---------------- */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var U = {
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
    },
    uid: function (p) { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
    /* Identificador persistente do navegador (cookie de 1 ano) — camada
       complementar ao IP na guarda anti-abuso do teste grátis. O usuário
       pode limpá-lo; por isso é sempre combinado com o limite por IP. */
    deviceId: function () {
      try {
        var m = document.cookie.match(/(?:^|;\s*)lc_did=([^;]+)/);
        if (m) return m[1];
        var id = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID()
          : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        document.cookie = 'lc_did=' + id + ';max-age=31536000;path=/;samesite=lax';
        return id;
      } catch (e) { return ''; }
    },
    clamp: function (v, a, b) { return Math.min(b, Math.max(a, v)); },
    round2: function (v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; },
    sum: function (arr, fn) { return (arr || []).reduce(function (a, x) { return a + (fn ? fn(x) : x); }, 0); },
    groupBy: function (arr, fn) {
      return (arr || []).reduce(function (acc, x) { var k = fn(x); (acc[k] = acc[k] || []).push(x); return acc; }, {});
    },
    debounce: function (fn, ms) {
      var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms || 220); };
    },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    clone: function (o) { return JSON.parse(JSON.stringify(o)); },
    /* Aceita "1.234,56", "1234.56", "1234,5" → número. Inválido → NaN */
    parseNum: function (v) {
      if (typeof v === 'number') return isFinite(v) ? v : NaN;
      var s = String(v == null ? '' : v).trim().replace(/[R$\s]/g, '');
      if (!s) return NaN;
      if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
      var n = parseFloat(s);
      return isFinite(n) ? n : NaN;
    },
    money: function (n) {
      return (isFinite(n) ? n : 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },
    num: function (n, dec) {
      return (isFinite(n) ? n : 0).toLocaleString('pt-BR', { maximumFractionDigits: dec == null ? 3 : dec });
    },
    pct: function (part, total) { return total > 0 ? Math.round((part / total) * 100) : 0; },
    date: function (d) { return new Date(d).toLocaleDateString('pt-BR'); },
    /* vencimento de plano: data completa COM hora — o prazo cai no mesmo
       horário da ativação (instante absoluto), mostrar só a data induz o
       cliente a achar que vale até 23:59 do dia (feedback externo v1.7.1) */
    datetime: function (d) {
      var t = new Date(d);
      return t.toLocaleDateString('pt-BR') + ' às ' +
             t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    },
    dt: function (d) {
      return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    iso: function (d) { return new Date(d).toISOString(); },
    weekday: function (d) { return new Date(d).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', ''); },
    dayStart: function (offset) { var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (offset || 0)); return d.getTime(); },
    addDays: function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; },
    initials: function (name) {
      var p = String(name || '?').trim().split(/\s+/);
      return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
    },
    pad: function (n, w) { return String(n).padStart(w || 6, '0'); },
    /* CSV: detecta delimitador (, ou ;), suporta aspas. Retorna matriz de strings. */
    csvParse: function (text) {
      var s = String(text || '').replace(/\r\n?/g, '\n').trim();
      if (!s) return [];
      var head = s.split('\n')[0];
      var delim = (head.split(';').length >= head.split(',').length) ? ';' : ',';
      var rows = [], row = [], cell = '', inQ = false;
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (inQ) {
          if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
          else cell += ch;
        } else if (ch === '"' && cell.trim() === '') inQ = true;
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
      }
      if (cell || row.length) { row.push(cell); rows.push(row); }
      return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    },
    csvBuild: function (headers, rows) {
      var q = function (v) { var s = String(v == null ? '' : v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      return '\uFEFF' + [headers.map(q).join(';')].concat(rows.map(function (r) { return r.map(q).join(';'); })).join('\n');
    },
    download: function (filename, content, mime) {
      try {
        var blob = content instanceof Blob ? content : new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
        return true;
      } catch (e) { console.warn('download falhou', e); return false; }
    }
  };

  /* ---------------- Template literal com escape automático ---------------- */
  function raw(v) { return { __raw: true, v: String(v) }; }
  function frag(x) {
    if (x == null || x === false || x === true) return '';
    if (x.__raw) return x.v;
    if (Array.isArray(x)) return x.map(frag).join('');
    return U.esc(x);
  }
  function html(strings) {
    var vals = Array.prototype.slice.call(arguments, 1);
    var out = strings[0];
    for (var i = 0; i < vals.length; i++) out += frag(vals[i]) + strings[i + 1];
    return raw(out);
  }
  function mount(el, f) { if (el) el.innerHTML = f && f.__raw ? f.v : frag(f); }

  /* ---------------- Event Bus ---------------- */
  var Bus = (function () {
    var map = {};
    return {
      on: function (ev, fn) { (map[ev] = map[ev] || []).push(fn); return function () { Bus.off(ev, fn); }; },
      off: function (ev, fn) { map[ev] = (map[ev] || []).filter(function (f) { return f !== fn; }); },
      emit: function (ev, data) {
        (map[ev] || []).slice().forEach(function (fn) {
          try { fn(data); } catch (e) { console.error('[Bus] handler "' + ev + '" falhou:', e); }
        });
      }
    };
  })();

  /* Analytics (stub pronto para GA4/Meta/Segment — ver INTEGRATIONS.md) */
  var Analytics = {
    track: function (event, props) {
      Bus.emit('analytics:track', { event: event, props: props || {} });
      if (Config && Config.env === 'demo') console.debug('[analytics:demo]', event, props || {});
    }
  };

  /* ---------------- Storage seguro (sandbox/file:// pode bloquear) ---------------- */
  var SafeStorage = (function () {
    var mem = {};
    var ok = (function () { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; } catch (e) { return false; } })();
    return {
      persistent: ok,
      get: function (k) { try { return ok ? localStorage.getItem(k) : (mem[k] != null ? mem[k] : null); } catch (e) { return mem[k] != null ? mem[k] : null; } },
      set: function (k, v) { try { if (ok) localStorage.setItem(k, v); else mem[k] = v; } catch (e) { mem[k] = v; } },
      remove: function (k) { try { if (ok) localStorage.removeItem(k); delete mem[k]; } catch (e) { delete mem[k]; } }
    };
  })();

  /* ---------------- Store (estado global + persistência) ---------------- */
  var STORE_KEY = 'lojacerta:store:v2';
  var Store = {
    state: null,
    init: function (seed) {
      var saved = null;
      try { saved = JSON.parse(SafeStorage.get(STORE_KEY) || 'null'); } catch (e) { saved = null; }
      if (saved && saved.meta && saved.meta.v === 1 && seed === undefined) {
        this.state = saved;
      } else if (saved && saved.meta && saved.meta.v === 1) {
        this.state = saved; // seed explícito só é usado quando não há estado salvo
      } else {
        this.state = seed;
        this.persist();
      }
      return this.state;
    },
    persist: function () { SafeStorage.set(STORE_KEY, JSON.stringify(this.state)); },
    update: function (fn) {
      fn(this.state);
      if (this.state.meta) this.state.meta.savedAt = Date.now();
      this.persist();
      Bus.emit('store:changed', this.state);
      return this.state;
    },
    reset: function (seed) { this.state = seed; this.persist(); Bus.emit('store:changed', this.state); },
    wipe: function () { SafeStorage.remove(STORE_KEY); }
  };

  /* ---------------- Router (hash) ---------------- */
  var Router = {
    routes: [], guards: [], current: null,
    add: function (path, handler) {
      this.routes.push({ path: path, handler: handler });
      return this;
    },
    guard: function (fn) { this.guards.push(fn); return this; },
    parse: function (hash) {
      var s = String(hash || '#/').replace(/^#/, '');
      var qi = s.indexOf('?');
      var path = (qi > -1 ? s.slice(0, qi) : s) || '/';
      var query = {};
      if (qi > -1) {
        new URLSearchParams(s.slice(qi + 1)).forEach(function (v, k) { query[k] = v; });
      }
      return { path: path, query: query };
    },
    match: function (hash) {
      var p = this.parse(hash);
      for (var i = 0; i < this.routes.length; i++) {
        var r = this.routes[i];
        var rp = r.path.split('/'), pp = p.path.split('/');
        if (rp.length !== pp.length) continue;
        var params = {}, ok = true;
        for (var j = 0; j < rp.length; j++) {
          if (rp[j].charAt(0) === ':') params[rp[j].slice(1)] = decodeURIComponent(pp[j]);
          else if (rp[j] !== pp[j]) { ok = false; break; }
        }
        if (ok) return { route: r, params: params, query: p.query, path: p.path };
      }
      return null;
    },
    start: function () {
      var self = this;
      var lastPath = this.parse(location.hash || '#/').path;
      window.addEventListener('hashchange', function () {
        /* v1.9 · modal aberto não sobrevive à troca de página (antes ficava
           por cima da tela nova bloqueando toques — ex.: "Confirmar venda") */
        var np = self.parse(location.hash || '#/').path;
        if (np !== lastPath && window.UI && UI.closeAll) UI.closeAll('route');
        lastPath = np;
        self.resolve();
      });
      this.resolve();
    },
    resolve: function () {
      var self = this;
      /* âncoras da landing (#planos etc.): rola até a seção e normaliza a URL */
      var pre = this.parse(location.hash || '#/');
      if (pre.path.charAt(0) !== '/') {
        var anchorEl = document.getElementById(pre.path);
        if (document.body.classList.contains('is-app')) Landing.show();
        history.replaceState(null, '', location.pathname + location.search + '#/');
        if (anchorEl) setTimeout(function () { anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
        return;
      }
      var m = this.match(location.hash || '#/');
      if (!m) { this.go('/', { replace: true }); return; }
      var chain = Promise.resolve(m);
      this.guards.forEach(function (g) {
        chain = chain.then(function (mm) {
          if (!mm) return mm;
          return Promise.resolve(g(mm)).then(function (res) {
            if (res === false) return null;
            if (typeof res === 'string') { self.go(res, { replace: true }); return null; }
            return mm;
          });
        });
      });
      chain.then(function (mm) {
        if (!mm) return;
        self.current = mm;
        try { mm.route.handler(mm.params, mm.query, mm); }
        catch (e) { console.error('[Router] handler falhou:', e); UI.toast('Erro interno ao abrir a página.', { type: 'err' }); }
        Bus.emit('route', mm);
      });
    },
    go: function (path, opts) {
      var h = '#' + path;
      if (location.hash === h) { this.resolve(); return; }
      if (opts && opts.replace) { history.replaceState(null, '', h); this.resolve(); }
      else location.hash = h;
    }
  };

  /* ---------------- Ícones SVG (traço 24×24, estilo feather) ---------------- */
  var ICONS = {
    headset: '<path d="M4 13v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4.5" height="7" rx="2"/><rect x="17" y="13" width="4.5" height="7" rx="2"/><path d="M19 20v.5a2.5 2.5 0 0 1-2.5 2.5H13" fill="none"/>',
    'arrow-left': '<path d="M19 12H5m7-7-7 7 7 7"/>',
    dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    cart: '<circle cx="9" cy="20.5" r="1.3"/><circle cx="18.5" cy="20.5" r="1.3"/><path d="M2 3h2.5l2.6 12.2a1.6 1.6 0 0 0 1.6 1.3h9.4a1.6 1.6 0 0 0 1.6-1.3L21.5 7H5.4"/>',
    package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    layers: '<path d="m12 2 9.5 5-9.5 5L2.5 7 12 2z"/><path d="m2.5 17 9.5 5 9.5-5M2.5 12l9.5 5 9.5-5"/>',
    receipt: '<path d="M5 2v20l2.5-1.6L10 22l2-1.6L14 22l2.5-1.6L19 22V2l-2.5 1.6L14 2l-2 1.6L10 2 7.5 3.6 5 2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    reports: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    billing: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7.5"/><path d="m21 21-4.35-4.35"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>',
    edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    'check-circle': '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12.5 2.5 2.5 4.5-5.5"/>',
    'x-circle': '<circle cx="12" cy="12" r="9.5"/><path d="m15 9-6 6M9 9l6 6"/>',
    clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    eye: '<path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    dollar: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    trending: '<path d="m23 6-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
    tag: '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16.5v-5M12 8h.01"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'arrow-right': '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    barcode: '<path d="M3 5v14M6.5 5v14M10 5v10M13.5 5v14M17 5v10M20.5 5v14"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="m22 7-10 6.5L2 7"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    store: '<path d="M3 21h18M4 21V7l8-4 8 4v14M9 21v-6h6v6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    import: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15l3-3 3 3"/>',
    'wifi-off': '<path d="m1 1 22 22M16.7 11.1A11 11 0 0 1 19 12.6M5 12.6a11 11 0 0 1 5.2-2.4M10.7 5.1A16 16 0 0 1 22.6 9M1.4 9a16 16 0 0 1 4.7-2.9M8.5 16.1a6 6 0 0 1 7 0M12 20h.01"/>',
    pix: '<path d="m12 2.5 4.7 4.7a3.4 3.4 0 0 1 0 4.8L12 16.7l-4.7-4.7a3.4 3.4 0 0 1 0-4.8L12 2.5z"/><path d="M7.3 7.2 4.8 9.7a3.3 3.3 0 0 0 0 4.6l2.5 2.5M16.7 7.2l2.5 2.5a3.3 3.3 0 0 1 0 4.6l-2.5 2.5"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.4-8.4M17.2 5.8l2.4 2.4M14.7 8.3l2.4 2.4"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
    scale: '<path d="M12 3v18M8 21h8"/><path d="M3 8h6l-3 6-3-6zM15 8h6l-3 6-3-6zM3 8l3-3 3 3M15 8l3-3 3 3"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'
  };
  function I(name, size, cls) {
    var inner = ICONS[name] || ICONS.info;
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
  }

  /* ---------------- UI: toasts, modais, helpers ---------------- */
  var UI = (function () {
    var TOAST_ICO = { ok: 'check-circle', warn: 'alert', err: 'x-circle', info: 'info' };
    var modalStack = [];

    function toast(msg, opts) {
      opts = opts || {};
      var type = opts.type || 'ok';
      var region = document.getElementById('toast-region');
      if (!region) return;
      while (region.children.length >= 4) region.removeChild(region.firstElementChild);
      var el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.setAttribute('role', type === 'err' ? 'alert' : 'status');
      el.innerHTML =
        '<span class="toast-ico">' + I(TOAST_ICO[type] || 'info', 17) + '</span>' +
        '<span class="toast-msg">' + (opts.title ? '<b>' + U.esc(opts.title) + '</b><br>' : '') + U.esc(msg) + '</span>' +
        '<button type="button" class="toast-x" aria-label="Fechar aviso">' + I('x', 13) + '</button>';
      /* timeout 'persist' (v1.7.3): aviso que fica até o usuário fechar —
         usado pelo aviso de "nova versão disponível" (cache do GH Pages) */
      var timer = opts.timeout === 'persist' ? 0 : setTimeout(close, opts.timeout || (type === 'err' ? 5600 : 3800));
      function close() {
        if (timer) clearTimeout(timer);
        el.classList.add('out');
        setTimeout(function () { el.remove(); }, 260);
      }
      el.querySelector('.toast-x').addEventListener('click', close);
      region.appendChild(el);
      return close;
    }

    function modal(cfg) {
      closeTop(); // um modal por vez (simples e previsível)
      var prevFocus = document.activeElement;
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal' + (cfg.size ? ' modal-' + cfg.size : '') + '" role="dialog" aria-modal="true"' + (cfg.title ? ' aria-labelledby="modal-title"' : '') + '>' +
          (cfg.title !== false ? '<div class="modal-head"><div><h3 id="modal-title">' + U.esc(cfg.title || '') + '</h3>' +
            (cfg.sub ? '<p class="modal-sub">' + U.esc(cfg.sub) + '</p>' : '') + '</div>' +
            '<button type="button" class="btn-icon sm" data-modal-close aria-label="Fechar">' + I('x', 16) + '</button></div>' : '') +
          '<div class="modal-body">' + (cfg.body && cfg.body.__raw ? cfg.body.v : U.esc(cfg.body || '')) + '</div>' +
          (cfg.foot ? '<div class="modal-foot">' + (cfg.foot.__raw ? cfg.foot.v : cfg.foot) + '</div>' : '') +
        '</div>';
      var root = document.getElementById('modal-root');
      root.appendChild(overlay);
      document.body.classList.add('no-scroll');
      var panel = overlay.querySelector('.modal');

      function close(result) {
        var idx = modalStack.indexOf(entry);
        if (idx > -1) modalStack.splice(idx, 1);
        overlay.remove();
        if (!modalStack.length) document.body.classList.remove('no-scroll');
        document.removeEventListener('keydown', onKey, true);
        if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { }
        if (cfg.onClose) cfg.onClose(result);
      }
      function onKey(e) {
        if (e.key === 'Escape' && cfg.dismissable !== false) { e.preventDefault(); close('esc'); return; }
        if (e.key === 'Tab') { // focus trap
          var f = panel.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && cfg.dismissable !== false) close('backdrop'); });
      overlay.querySelectorAll('[data-modal-close]').forEach(function (b) { b.addEventListener('click', function () { close('x'); }); });
      var entry = { el: panel, overlay: overlay, close: close };
      modalStack.push(entry);
      if (cfg.onMount) cfg.onMount(panel, close);
      var auto = panel.querySelector('[data-autofocus]') || panel.querySelector('input:not([type=hidden]),select,textarea,button');
      if (auto) setTimeout(function () { try { auto.focus(); } catch (e) { } }, 40);
      return entry;
    }
    function closeTop() { if (modalStack.length) modalStack[modalStack.length - 1].close('replaced'); }
    function closeAll(reason) { while (modalStack.length) modalStack[modalStack.length - 1].close(reason || 'replaced'); }

    function confirmDialog(cfg) {
      return new Promise(function (resolve) {
        var done = false;
        var m = modal({
          title: cfg.title || 'Confirmar', size: 'sm',
          body: html`<p style="color:var(--ink-2);font-size:.9rem;line-height:1.6">${raw(cfg.html || U.esc(cfg.text || ''))}</p>` +
            (cfg.input ? raw('<div class="field mt-3"><label class="field-label" for="cf-input">' + U.esc(cfg.inputLabel || 'Observação') + '</label><input class="input" id="cf-input" value="' + U.esc(cfg.inputValue || '') + '"></div>') : ''),
          foot: raw('<button type="button" class="btn btn-ghost" data-no>' + U.esc(cfg.cancelText || 'Voltar') + '</button>' +
            '<button type="button" class="btn ' + (cfg.danger ? 'btn-danger' : 'btn-primary') + '" data-yes data-autofocus>' + U.esc(cfg.okText || 'Confirmar') + '</button>'),
          onClose: function (r) { if (!done) { done = true; resolve(r === 'yes' ? collect(m) : false); } },
          onMount: function (panel, close) {
            panel.querySelector('[data-no]').addEventListener('click', function () { close('no'); });
            panel.querySelector('[data-yes]').addEventListener('click', function () { close('yes'); });
          }
        });
        function collect(mm) {
          var inp = mm && mm.el ? mm.el.querySelector('#cf-input') : null;
          return inp ? { ok: true, value: inp.value } : true;
        }
      });
    }

    function busy(btn, on) {
      if (!btn) return;
      if (on) {
        if (btn.dataset.busyHtml) return;
        btn.dataset.busyHtml = btn.innerHTML;
        btn.classList.add('is-busy');
        btn.setAttribute('aria-busy', 'true');
        btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Aguarde…';
      } else {
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        if (btn.dataset.busyHtml) { btn.innerHTML = btn.dataset.busyHtml; delete btn.dataset.busyHtml; }
      }
    }
    return { toast: toast, modal: modal, confirm: confirmDialog, busy: busy, closeTopModal: closeTop, closeAll: closeAll };
  })();

  /* ---------------- Validação de formulários ---------------- */
  var Validate = {
    rules: {
      required: function (v) { return String(v == null ? '' : v).trim() ? null : 'Campo obrigatório'; },
      email: function (v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim()) ? null : 'E-mail inválido'; },
      min: function (v, n) { return !v || String(v).length >= n ? null : 'Mínimo de ' + n + ' caracteres'; },
      num: function (v) { return v === '' || v == null || !isNaN(U.parseNum(v)) ? null : 'Número inválido'; },
      gt0: function (v) { var n = U.parseNum(v); return v === '' || v == null || (isFinite(n) && n > 0) ? null : 'Deve ser maior que zero'; },
      gte0: function (v) { var n = U.parseNum(v); return v === '' || v == null || (isFinite(n) && n >= 0) ? null : 'Não pode ser negativo'; },
      cnpjOpcional: function (v) { return !v || /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(v).trim()) ? null : 'CNPJ inválido (use 00.000.000/0001-00)' }
    },
    /* schema: { fieldName: [['required'],['min',6],...] } */
    run: function (formEl, schema) {
      var values = {}, errors = {};
      Object.keys(schema).forEach(function (name) {
        var el = formEl.elements[name];
        var v = el ? (el.type === 'checkbox' ? el.checked : el.value) : '';
        values[name] = v;
        for (var i = 0; i < schema[name].length; i++) {
          var r = schema[name][i];
          var fn = Validate.rules[r[0]];
          if (!fn) continue;
          var err = fn(v, r[1]);
          if (err) { errors[name] = err; break; }
        }
      });
      return { ok: Object.keys(errors).length === 0, values: values, errors: errors };
    },
    paint: function (formEl, errors) {
      formEl.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
      formEl.querySelectorAll('.field-error').forEach(function (el) { el.remove(); });
      var first = null;
      Object.keys(errors).forEach(function (name) {
        var el = formEl.elements[name];
        if (!el) return;
        el.setAttribute('aria-invalid', 'true');
        var id = 'err-' + name;
        el.setAttribute('aria-describedby', id);
        var d = document.createElement('p');
        d.className = 'field-error'; d.id = id; d.setAttribute('role', 'alert');
        d.innerHTML = I('alert', 13) + '<span>' + U.esc(errors[name]) + '</span>';
        var field = el.closest('.field') || el.parentElement;
        field.appendChild(d);
        if (!first) first = el;
      });
      if (first) { try { first.focus(); } catch (e) { } }
      return Object.keys(errors).length;
    },
    passwordStrength: function (pw) {
      var s = 0;
      if (!pw) return 0;
      if (pw.length >= 6) s++;
      if (pw.length >= 10) s++;
      if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
      if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
      return U.clamp(s, 0, 4);
    }
  };

  /* ---------------- Permissões (RBAC simples) ---------------- */
  var PERM_MATRIX = {
    admin: '*',
    gerente: ['dashboard', 'pdv', 'produtos', 'estoque', 'vendas', 'relatorios', 'assinatura', 'suporte', 'custo.view', 'discount.unlimited', 'inventory.manage', 'products.manage'],
    operador: ['dashboard', 'pdv', 'vendas', 'suporte', 'discount.limited'],
    /* Equipe JR Sistemas: conta interna com TUDO liberado (tempo indeterminado).
       No Suporte vê o painel de atendimento (tickets de todas as empresas). */
    dev: '*'
  };
  var Perms = {
    role: function () {
      var u = Auth.me();
      return u ? u.papel : null;
    },
    can: function (action) {
      var role = this.role();
      if (!role) return false;
      var list = PERM_MATRIX[role];
      if (list === '*') return true;
      if (list.indexOf(action) > -1) return true;
      return list.indexOf(action.split('.')[0]) > -1; // "assinatura.view" casa com página "assinatura"? não — páginas listadas explicitamente
    },
    pageAllowed: function (page) {
      var role = this.role();
      if (!role) return false;
      var list = PERM_MATRIX[role];
      return list === '*' || list.indexOf(page) > -1;
    }
  };

  /* ---------------- Erros globais ---------------- */
  var lastErrToast = 0;
  window.addEventListener('error', function (e) {
    console.error('[erro global]', e.error || e.message);
    if (Date.now() - lastErrToast > 8000) { lastErrToast = Date.now(); }
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('[promise rejeitada]', e.reason);
  });

  /* ---------------- DOM ready ---------------- */
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* ---------------- Tabelas responsivas (v1.9) ----------------
     No celular (≤640px) cada <tr> vira um cartão (CSS em app.css). O rótulo
     de cada célula vem do <th> correspondente via data-label — aplicado
     automaticamente a qualquer tabela .table renderizada, sem tocar nas telas. */
  function labelTables(root) {
    var tables = (root && root.querySelectorAll) ? root.querySelectorAll('table.table') : [];
    for (var t = 0; t < tables.length; t++) {
      var ths = tables[t].querySelectorAll('thead th');
      if (!ths.length) continue;
      var labels = []; for (var h = 0; h < ths.length; h++) labels.push((ths[h].textContent || '').trim());
      var rows = tables[t].querySelectorAll('tbody tr');
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].children;
        for (var c = 0; c < cells.length; c++) {
          if (cells[c].hasAttribute('colspan')) { cells[c].setAttribute('data-label', ''); continue; }
          if (cells[c].getAttribute('data-label') !== labels[c]) cells[c].setAttribute('data-label', labels[c] || '');
        }
      }
    }
  }
  if (typeof MutationObserver !== 'undefined') {
    var _ltPending = false;
    var _lt = new MutationObserver(function () {
      if (_ltPending) return; _ltPending = true;
      (window.requestAnimationFrame || setTimeout)(function () { _ltPending = false; labelTables(document); });
    });
    ready(function () { labelTables(document); _lt.observe(document.body, { childList: true, subtree: true }); });
  }

  /* ---------------- Theme (light/dark) ---------------- */
  var Theme = {
    KEY: 'lojacerta:theme',
    init: function () {
      var saved = SafeStorage.get(this.KEY);
      var root = document.documentElement;
      if (saved) {
        root.setAttribute('data-theme', saved);
      } else {
        /* auto: use system preference, default to light */
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      }
      this.updateIcons();
    },
    toggle: function () {
      var root = document.documentElement;
      var current = root.getAttribute('data-theme') || 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      SafeStorage.set(this.KEY, next);
      this.updateIcons();
      Analytics.track('theme_changed', { theme: next });
    },
    set: function (theme) {
      var root = document.documentElement;
      root.setAttribute('data-theme', theme);
      SafeStorage.set(this.KEY, theme);
      this.updateIcons();
    },
    updateIcons: function () {
      var root = document.documentElement;
      var isDark = root.getAttribute('data-theme') === 'dark';
      document.querySelectorAll('[data-act="theme-toggle"]').forEach(function (btn) {
        btn.setAttribute('aria-label', isDark ? 'Alternar para tema claro' : 'Alternar para tema escuro');
      });
    }
  };

  /* Expose theme toggle for global dispatcher */
  window.Theme = Theme;

  /* ---------------- Exporta ---------------- */
  window.U = U; window.html = html; window.raw = raw; window.frag = frag; window.mount = mount;
  window.Bus = Bus; window.Store = Store; window.SafeStorage = SafeStorage;
  window.Router = Router; window.UI = UI; window.I = I; window.ICONS = ICONS;
  window.Validate = Validate; window.Perms = Perms; window.Analytics = Analytics; window.ready = ready; window.labelTables = labelTables;
})();
