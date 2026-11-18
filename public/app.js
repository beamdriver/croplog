(() => {
  'use strict';
  const CFG = window.CROPLOG_CONFIG;
  const app = document.getElementById('app');
  const MIN_MONTH = new Date(2010, 3, 1);

  // ---------- data layer (JSON from the Olog and Shift REST services) ----------
  const epoch = (d) => Math.floor(d.getTime() / 1000);
  const parseDate = (s) => Date.parse(String(s ?? '').replace(/\[.*\]$/, '')); // "2026-11-17T13:03:47Z[UTC]"
  const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const asArray = (j) => (Array.isArray(j) ? j : j && typeof j === 'object' ? [j] : []);

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `Request failed (${res.status})`);
    return res.json();
  }

  function mapLog(l) {
    const shiftProp = (l.properties ?? []).find((p) => p.name === 'Shift');
    const id = Number(shiftProp?.attributes?.Id);
    return {
      id: l.id,
      version: Number(l.version ?? 1),
      owner: l.owner ?? '',
      created: Number(l.createdDate),
      description: l.description ?? '',
      tags: (l.tags ?? []).map((t) => t.name),
      attachments: (l.attachments ?? []).map((a) => ({ fileName: a.fileName, contentType: a.contentType ?? '' })),
      shiftId: id > 0 ? id : null,
    };
  }

  // history=true returns every version of an entry; keep only the latest, newest entry first.
  function latestEntries(json) {
    const latest = new Map();
    for (const l of asArray(json).map(mapLog)) {
      const cur = latest.get(l.id);
      if (!cur || l.version > cur.version) latest.set(l.id, l);
    }
    return [...latest.values()].sort((a, b) => b.created - a.created);
  }

  const mapShift = (s) => ({
    id: Number(s.id),
    owner: s.owner ?? '',
    leadOperator: s.leadOperator ?? '',
    startDate: parseDate(s.startDate),
    endDate: parseDate(s.endDate),
    description: s.description ?? '',
    personnel: s.onShiftPersonal ?? '',
    derived: false,
  });

  // With CFG.proxy set, all requests go through one same-origin proxy script (proxy.php?svc=olog|shift&...);
  // otherwise the services are called directly.
  const ologUrl = (path, params = {}) => (CFG.proxy
    ? `${CFG.proxy}${qs({ svc: 'olog', path, ...params })}`
    : `${CFG.olog}${path}${qs(params)}`);
  const shiftUrl = ({ type, ...params }) => (CFG.proxy
    ? `${CFG.proxy}${qs({ svc: 'shift', type, ...params })}`
    : `${CFG.shift}${type ? `/${type}` : ''}${qs(params)}`);

  const logs = (p) => getJson(ologUrl('logs', { history: 'true', ...p })).then(latestEntries);

  // The Shift service may not allow cross-origin requests from a browser; once it fails, shift details are
  // derived from the Olog entries' "Shift" property instead.
  let shiftServiceDown = false;
  async function shiftService(params) {
    if (shiftServiceDown) throw new Error('Shift service unavailable');
    try {
      return asArray(await getJson(shiftUrl(params)));
    } catch (err) {
      if (err instanceof TypeError) shiftServiceDown = true; // network/CORS failure; HTTP errors don't latch
      console.warn('Shift service request failed:', params, err);
      throw err;
    }
  }

  function deriveShift(id, entries) {
    const times = entries.map((e) => e.created);
    const oldest = [...entries].sort((a, b) => a.created - b.created)[0];
    return {
      id, owner: oldest?.owner ?? '', leadOperator: '', startDate: Math.min(...times), endDate: NaN,
      description: oldest?.description ?? '', personnel: '', derived: true,
    };
  }

  const api = {
    async latestShift() {
      try {
        const [s] = await shiftService({ type: 'Operations', limit: 1 });
        if (s) return mapShift(s);
      } catch { /* fall through to Olog-derived */ }
      const recent = await logs({ limit: 30 });
      const id = recent.find((e) => e.shiftId)?.shiftId;
      if (!id) throw new Error('No shifts found');
      return deriveShift(id, recent.filter((e) => e.shiftId === id));
    },
    async shifts(from, to) {
      try {
        return (await shiftService({ from: epoch(from), to: epoch(to) })).map(mapShift);
      } catch { /* derive from the month's entries */ }
      const entries = await logs({ start: epoch(from), end: epoch(to), limit: 1000 });
      const groups = new Map();
      for (const e of entries) if (e.shiftId) groups.set(e.shiftId, [...(groups.get(e.shiftId) ?? []), e]);
      return [...groups].map(([id, es]) => deriveShift(id, es));
    },
    // A shift's entries are those in its time window (minus any explicitly assigned elsewhere) plus any
    // explicitly assigned to it.
    async shift(id) {
      const explicit = await logs({ 'Shift.Id': id });
      let shift;
      try {
        const [s] = await shiftService({ id });
        if (s) shift = mapShift(s);
      } catch { /* derived below */ }
      if (!shift) {
        if (!explicit.length) throw new Error('Shift not found');
        return { shift: deriveShift(id, explicit), entries: [...explicit].sort((a, b) => a.created - b.created) };
      }
      const open = !(shift.endDate > shift.startDate);
      const windowed = await logs({ start: epoch(new Date(shift.startDate)), end: open ? '' : epoch(new Date(shift.endDate)) });
      const merged = new Map();
      for (const e of [...windowed.filter((e) => !e.shiftId || e.shiftId === id), ...explicit]) merged.set(e.id, e);
      return { shift, entries: [...merged.values()].sort((a, b) => a.created - b.created) };
    },
    entries: ({ start, end, tag, text, limit }) =>
      logs({ start: start && epoch(start), end: end && epoch(end), tag, search: text ? `*${text}*` : '', limit }),
    async tags() {
      const j = await getJson(ologUrl('tags'));
      return asArray(j.tag ?? j).map((t) => t.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
    },
    attachmentUrl: (id, file, thumb = false) =>
      ologUrl(`attachments/${id}/${CFG.proxy ? file : encodeURIComponent(file)}${thumb ? ':thumbnail' : ''}`),
  };

  // ---------- DOM helpers ----------
  // Builds DOM nodes; string children become text nodes, so nothing from the Olog is parsed as HTML.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }
  const link = (path, label, props = {}) => h('a', { href: `#${path}`, ...props }, label);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: false });

  let token = 0; // discards results from navigations that have been superseded
  async function load(render, fetcher) {
    const mine = ++token;
    app.replaceChildren(h('p', { class: 'status' }, 'Loading…'));
    try {
      const data = await fetcher();
      if (mine === token) app.replaceChildren(...[].concat(render(data)).flat().filter((n) => n != null && n !== false));
    } catch (err) {
      if (mine === token) app.replaceChildren(h('p', { class: 'status error', role: 'alert' }, err.message));
    }
  }
  const show = (...nodes) => {
    token++;
    app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
  };

  // ---------- components ----------
  const derivedNotice = () =>
    h('p', { class: 'status' }, 'Shift service not reachable from this browser; shift details are derived from log entries.');

  function shiftHeader(s) {
    const item = (dt, dd) => h('div', {}, h('dt', {}, dt), h('dd', {}, dd));
    return h('section', { class: 'card shift-header' },
      h('dl', {},
        item('Owner', s.owner || '—'),
        item('Lead operator', s.leadOperator || '—'),
        item(s.derived ? 'First entry' : 'Start', Number.isFinite(s.startDate) ? fmtDateTime(s.startDate) : '—'),
        item('End', Number.isFinite(s.endDate) ? fmtDateTime(s.endDate) : s.derived ? '—' : 'In progress')),
      s.personnel && h('p', {}, s.personnel),
      s.description && h('p', { class: 'shift-description' }, s.description),
      s.derived && derivedNotice());
  }

  // Modal viewer for an entry's images, with previous/next when the entry has several.
  function openLightbox(entry, attachment) {
    const images = entry.attachments.filter((a) => a.contentType.startsWith('image/'));
    let i = Math.max(0, images.findIndex((a) => a.fileName === attachment.fileName));
    const img = h('img', { alt: '' });
    const caption = h('p', { class: 'lightbox-caption' });
    const full = h('a', { target: '_blank', rel: 'noreferrer' }, 'Open original');
    const many = images.length > 1;
    const step = (d) => { i = (i + d + images.length) % images.length; render(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
    const onKey = (ev) => {
      if (ev.key === 'Escape') close();
      else if (many && ev.key === 'ArrowLeft') step(-1);
      else if (many && ev.key === 'ArrowRight') step(1);
    };
    const overlay = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image viewer', onclick: (ev) => { if (ev.target === overlay) close(); } },
      h('button', { class: 'lb-btn lb-close', type: 'button', 'aria-label': 'Close', onclick: close }, '×'),
      many && h('button', { class: 'lb-btn lb-prev', type: 'button', 'aria-label': 'Previous image', onclick: () => step(-1) }, '‹'),
      h('figure', {}, img, h('figcaption', {}, caption, ' ', full)),
      many && h('button', { class: 'lb-btn lb-next', type: 'button', 'aria-label': 'Next image', onclick: () => step(1) }, '›'));
    function render() {
      const a = images[i];
      img.src = api.attachmentUrl(entry.id, a.fileName);
      img.alt = a.fileName;
      full.href = img.src;
      caption.textContent = many ? `${a.fileName} (${i + 1} of ${images.length})` : a.fileName;
    }
    render();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    document.body.append(overlay);
    overlay.querySelector('.lb-close').focus();
  }

  function entryList(entries, showDate = false) {
    if (!entries.length) return h('p', { class: 'status' }, 'No entries found.');
    return h('ol', { class: 'entries' }, entries.map((e) =>
      h('li', { class: 'card entry' },
        h('header', {},
          h('time', {}, showDate ? fmtDateTime(e.created) : fmtTime(e.created)),
          h('span', {}, e.owner), h('span', {}, `#${e.id}`),
          e.shiftId && link(`/shift/${e.shiftId}`, `Shift ${e.shiftId}`)),
        h('p', { class: 'entry-text' }, e.description),
        e.attachments.length > 0 && h('div', { class: 'attachments' }, e.attachments.map((a) => {
          const isImg = a.contentType.startsWith('image/');
          return h('a', {
            href: api.attachmentUrl(e.id, a.fileName), target: '_blank', rel: 'noreferrer',
            onclick: isImg ? (ev) => { ev.preventDefault(); openLightbox(e, a); } : null,
          }, isImg ? h('img', { src: api.attachmentUrl(e.id, a.fileName, true), alt: a.fileName, loading: 'lazy' }) : a.fileName);
        })),
        e.tags.length > 0 && h('ul', { class: 'tag-chips' }, e.tags.map((t) => h('li', {}, link(`/tag/${encodeURIComponent(t)}`, t)))))));
  }

  const pager = (prev, next) =>
    h('nav', { class: 'pager' }, prev ? link(...prev) : h('span'), next ? link(...next) : h('span'));

  function searchForm(tags, p = new URLSearchParams()) {
    const input = (name, type, extra = {}) => h('input', { name, type, value: p.get(name) ?? '', ...extra });
    const select = h('select', { name: 'tag', 'aria-label': 'Tag' }, h('option', { value: '' }, 'Any tag'),
      tags.map((t) => h('option', { value: t, selected: t === p.get('tag') }, t)));
    return h('form', {
      class: 'card search-form',
      onsubmit: (e) => {
        e.preventDefault();
        const out = new URLSearchParams();
        new FormData(e.currentTarget).forEach((v, k) => v && out.set(k, v));
        navigate(`/search?${out}`);
      },
    }, input('q', 'search', { placeholder: 'Search text', 'aria-label': 'Search text' }),
      h('label', {}, 'After', input('from', 'date')), h('label', {}, 'Before', input('to', 'date')),
      select, h('button', { type: 'submit' }, 'Search'));
  }

  // ---------- pages ----------
  const dashboard = () => load(({ latest, tags }) => [
    h('h1', {}, 'Croplog'),
    h('h2', {}, `Active shift #${latest.id}`),
    shiftHeader(latest),
    h('p', {}, link(`/shift/${latest.id}`, 'View shift log', { class: 'button' })),
    h('div', { class: 'tiles' },
      ...[['/month', 'Calendar', 'Monthly view of shifts'], ['/tags', 'Tags', 'Browse entries by tag'], ['/day', 'Today', 'All entries for a day']]
        .map(([p, t, d]) => link(p, [h('h3', {}, t), h('p', {}, d)], { class: 'card tile' }))),
    h('h2', {}, 'Search'),
    searchForm(tags),
  ], async () => {
    const [latest, tags] = await Promise.all([api.latestShift(), api.tags().catch(() => [])]);
    return { latest, tags };
  });

  function shiftPage(idStr) {
    if (!idStr) return load(() => [], async () => { navigate(`/shift/${(await api.latestShift()).id}`, true); });
    const id = Number(idStr);
    if (!Number.isInteger(id) || id < 1) return show(h('p', { class: 'status error' }, 'Invalid shift.'));
    load(({ data, last }) => {
      const nav = () => pager(id > 1 ? [`/shift/${id - 1}`, `‹ Shift ${id - 1}`] : null, id < last ? [`/shift/${id + 1}`, `Shift ${id + 1} ›`] : null);
      return [h('h1', {}, `Shift ${id}`), shiftHeader(data.shift), nav(), entryList(data.entries), nav()];
    }, async () => {
      const [data, latest] = await Promise.all([api.shift(id), api.latestShift().catch(() => ({ id }))]);
      return { data, last: latest.id };
    });
  }

  function dayPage(date = ymd(new Date())) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return show(h('p', { class: 'status error' }, 'Invalid date.'));
    const [y, m, d] = date.split('-').map(Number);
    const at = (n) => ymd(new Date(y, m - 1, d + n));
    load((entries) => [
      h('h1', {}, new Date(y, m - 1, d).toLocaleDateString([], { dateStyle: 'full' })),
      pager([`/day/${at(-1)}`, '‹ Previous day'], date < ymd(new Date()) ? [`/day/${at(1)}`, 'Next day ›'] : null),
      entryList(entries),
    ], () => api.entries({ start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1) }));
  }

  function monthPicker(year, month, now) {
    const lastYear = now.getFullYear();
    const monthSel = h('select', { 'aria-label': 'Month' }, Array.from({ length: 12 }, (_, m) =>
      h('option', { value: m + 1, selected: m + 1 === month }, new Date(2000, m, 1).toLocaleDateString([], { month: 'long' }))));
    const yearSel = h('select', { 'aria-label': 'Year' }, Array.from({ length: lastYear - MIN_MONTH.getFullYear() + 1 }, (_, k) => lastYear - k)
      .map((y) => h('option', { value: y, selected: y === year }, String(y))));
    const go = () => {
      let y = Number(yearSel.value), m = Number(monthSel.value);
      // clamp to the range with data (April 2010 .. current month)
      if (new Date(y, m - 1, 1) < MIN_MONTH) { y = MIN_MONTH.getFullYear(); m = MIN_MONTH.getMonth() + 1; }
      if (new Date(y, m - 1, 1) > now) { y = now.getFullYear(); m = now.getMonth() + 1; }
      navigate(`/month/${y}/${pad(m)}`);
    };
    return h('div', { class: 'month-picker' }, monthSel, yearSel, h('button', { type: 'button', onclick: go }, 'Go'));
  }

  function monthPage(yearStr, monthStr) {
    const now = new Date();
    const year = Number(yearStr ?? now.getFullYear());
    const month = Number(monthStr ?? now.getMonth() + 1);
    const first = new Date(year, month - 1, 1);
    if (!Number.isInteger(year) || month < 1 || month > 12 || first < MIN_MONTH) return navigate('/month', true);
    const next = new Date(year, month, 1);
    const prev = new Date(year, month - 2, 1);
    const path = (d) => `/month/${d.getFullYear()}/${pad(d.getMonth() + 1)}`;
    load((shifts) => {
      const byDay = new Map();
      for (const s of [...shifts].sort((a, b) => a.id - b.id)) {
        const k = new Date(s.startDate).getDate();
        byDay.set(k, [...(byDay.get(k) ?? []), s]);
      }
      const daysIn = new Date(year, month, 0).getDate();
      const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)];
      const dow = (d) => d.toLocaleDateString([], { weekday: 'short' });
      return [
        h('h1', {}, first.toLocaleDateString([], { month: 'long', year: 'numeric' })),
        pager(prev >= MIN_MONTH ? [path(prev), '‹ Previous'] : null, next <= now ? [path(next), 'Next ›'] : null),
        monthPicker(year, month, now),
        shifts.some((s) => s.derived) ? derivedNotice() : null,
        h('div', { class: 'calendar', role: 'grid' },
          Array.from({ length: 7 }, (_, i) => h('div', { class: 'dow', role: 'columnheader' }, dow(new Date(2024, 0, 7 + i)))),
          cells.map((d) => d === null ? h('div', { class: 'day blank' }) : h('div', { class: 'day', role: 'gridcell' },
            link(`/day/${ymd(new Date(year, month - 1, d))}`, [h('span', { class: 'dow-inline' }, `${dow(new Date(year, month - 1, d))} `), String(d)], { class: 'daynum' }),
            (byDay.get(d) ?? []).map((s) => link(`/shift/${s.id}`, [`${s.id} `, h('small', {}, s.owner)], { class: 'shift-pill' }))))),
      ];
    }, () => api.shifts(first, next));
  }

  const tagsPage = () => load((tags) => [h('h1', {}, 'Tags'),
    h('ul', { class: 'tag-chips big' }, tags.map((t) => h('li', {}, link(`/tag/${encodeURIComponent(t)}`, t))))], api.tags);

  const tagPage = (name) => load((entries) => [
    h('h1', {}, 'Entries tagged ', h('span', { class: 'tagname' }, name)), entryList(entries, true)],
  () => api.entries({ tag: name, limit: 50 }));

  async function searchPage(p) {
    const tags = await api.tags().catch(() => []);
    const text = p.get('q') ?? '', tag = p.get('tag') ?? '';
    const start = p.get('from') ? new Date(`${p.get('from')}T00:00:00`) : undefined;
    const end = p.get('to') ? new Date(`${p.get('to')}T23:59:59`) : undefined;
    const form = searchForm(tags, p);
    if (!(text || tag || start || end)) return show(h('h1', {}, 'Search'), form);
    load((entries) => [h('h1', {}, 'Search'), form,
      h('p', { class: 'status' }, `${entries.length} result${entries.length === 1 ? '' : 's'} (max 100)`), entryList(entries, true)],
    () => api.entries({ start, end, tag, text, limit: 100 }));
  }

  const schedulePage = () => show(h('h1', {}, 'Operations Schedule'), h('div', { class: 'embed' }, h('iframe', {
    title: 'Operations schedule',
    src: 'https://calendar.google.com/calendar/embed?src=fs18ji5neevgl5gi62ntpfdd64%40group.calendar.google.com&ctz=America/New_York',
  })));
  const aboutPage = () => show(h('h1', {}, 'About Croplog'),
    h('p', {}, 'Croplog is a web interface to the NSLS-II Olog. This is version 3.0, a plain JavaScript app that runs entirely in the browser. Questions or suggestions: Gary Weiner (gjw@bnl.gov).'));

  // ---------- router (hash based, so it works from any static host or file://) ----------
  const routes = [
    [/^\/$/, () => dashboard()],
    [/^\/shift(?:\/(\d+))?$/, (id) => shiftPage(id)],
    [/^\/day(?:\/([\d-]+))?$/, (d) => dayPage(d)],
    [/^\/month(?:\/(\d{4})\/(\d{1,2}))?$/, (y, m) => monthPage(y, m)],
    [/^\/tags$/, () => tagsPage()],
    [/^\/tag\/(.+)$/, (n) => tagPage(decodeURIComponent(n))],
    [/^\/search$/, (q) => searchPage(new URLSearchParams(q))],
    [/^\/schedule$/, () => schedulePage()],
    [/^\/about$/, () => aboutPage()],
  ];

  function route() {
    const [pathname, query = ''] = (location.hash.slice(1) || '/').split('?');
    for (const a of document.querySelectorAll('.topbar nav a')) {
      const p = a.getAttribute('href').slice(1);
      a.classList.toggle('active', pathname === p || (p !== '/' && pathname.startsWith(`${p}/`)));
    }
    window.scrollTo(0, 0);
    for (const [re, fn] of routes) {
      const m = re.exec(pathname);
      if (m) return fn(...m.slice(1), query);
    }
    show(h('p', { class: 'status error' }, 'Page not found. ', link('/', 'Home')));
  }

  function navigate(path, replace = false) {
    if (replace) history.replaceState(null, '', `#${path}`);
    else if (location.hash !== `#${path}`) return void (location.hash = path);
    route();
  }

  window.addEventListener('hashchange', route);
  route();
})();
