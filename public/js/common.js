/* Shared helpers. All user-supplied text goes through textContent, never innerHTML. */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function shuffle(list) {
  const a = [...list];
  const buf = new Uint32Array(a.length);
  crypto.getRandomValues(buf);
  for (let i = a.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function storage() {
  return {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ } }
  };
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'fixed opacity-0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (button) {
    const old = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = old; }, 1500);
  }
}

/** A labelled, read-only link with a Copy button. */
function linkBox(label, hint, path, tone = 'emerald') {
  const full = `${location.origin}${path}`;
  const btn = h('button', {
    type: 'button',
    class: `shrink-0 rounded-lg bg-${tone}-600 hover:bg-${tone}-500 px-4 py-2 text-sm font-semibold text-white`,
    onclick: () => copyText(full, btn)
  }, 'Copy');
  return h('div', { class: 'rounded-xl bg-slate-900/60 p-4 ring-1 ring-slate-700' },
    h('div', { class: 'text-sm font-semibold text-slate-100' }, label),
    h('div', { class: 'mb-2 text-xs text-slate-400' }, hint),
    h('div', { class: 'flex gap-2' },
      h('input', { readonly: true, value: full, 'aria-label': label, class: 'min-w-0 flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100 ring-1 ring-slate-600', onfocus: (e) => e.target.select() }),
      btn));
}

/** Names that appear more than once in a session need extra detail to tell apart. */
function duplicateNames(cubes) {
  const count = {};
  for (const c of cubes) {
    const k = c.name.trim().toLowerCase();
    count[k] = (count[k] || 0) + 1;
  }
  return new Set(Object.keys(count).filter((k) => count[k] > 1));
}

/** Name, author, card count and link for a cube. Duplicate names also show the full URL. */
function cubeInfo(cube, dupes) {
  const isDupe = dupes.has(cube.name.trim().toLowerCase());
  const facts = [cube.author ? `by ${cube.author}` : null, cube.cardCount != null ? `${cube.cardCount} cards` : null].filter(Boolean);
  const shortUrl = cube.url ? cube.url.replace(/^https?:\/\//, '') : null;
  return h('div', { class: 'min-w-0' },
    h('div', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: 'font-semibold text-slate-50 break-words' }, cube.name),
      isDupe && h('span', { class: 'rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-300' }, 'same name as another cube')),
    facts.length > 0 && h('div', { class: 'text-sm text-slate-300' }, facts.join(' · ')),
    cube.url && h('a', { href: cube.url, target: '_blank', rel: 'noopener noreferrer', class: `mt-1 block break-all text-xs text-sky-400 hover:underline` },
      isDupe ? shortUrl : 'View on Cube Cobra'));
}

function showError(container, message) {
  container.replaceChildren(h('div', { class: 'rounded-xl bg-red-900/40 p-4 text-red-200 ring-1 ring-red-700' }, message));
}

/** The logged-in Discord player, or null. Fetched once per page. */
let mePromise = null;
function getMe() {
  if (!mePromise) mePromise = api('/me').catch(() => ({ enabled: false, player: null }));
  return mePromise;
}

function avatar(p, size = 'h-6 w-6') {
  return p.avatarUrl
    ? h('img', { src: p.avatarUrl, alt: '', class: `${size} shrink-0 rounded-full` })
    : h('span', { class: `${size} inline-flex shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white` }, p.name.slice(0, 1).toUpperCase());
}

/** Login status line with Discord login or logout. */
async function accountBar() {
  const { enabled, player } = await getMe();
  if (!enabled) return '';
  const next = encodeURIComponent(location.pathname);
  const right = player
    ? h('span', { class: 'flex items-center gap-2' },
      h('a', { href: `/players/${player.id}`, class: 'flex items-center gap-2 text-slate-200 hover:underline' }, avatar(player), player.name),
      h('button', { type: 'button', class: 'text-slate-400 hover:text-slate-200 hover:underline', onclick: async () => {
        await api('/auth/logout', { method: 'POST' });
        location.reload();
      } }, 'Log out'))
    : h('a', { href: `/auth/discord?next=${next}`, class: 'rounded-lg bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500' }, 'Log in with Discord');
  return h('div', { class: 'mb-4 flex items-center justify-end gap-3 text-sm' }, right);
}

/**
 * An in-page confirmation window. Resolves true when confirmed, false on Cancel,
 * Escape or a click outside. Used instead of the browser's confirm(), which some
 * browsers block or hide after a few uses.
 */
function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const btn = 'rounded-lg px-4 py-2 text-sm font-semibold';
    const cancel = h('button', { type: 'button', class: `${btn} bg-slate-700 text-slate-100 hover:bg-slate-600` }, 'Cancel');
    const ok = h('button', { type: 'button', class: `${btn} text-white ${danger ? 'bg-red-700 hover:bg-red-600' : 'bg-emerald-600 hover:bg-emerald-500'}` }, confirmLabel);
    const overlay = h('div', { class: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4' },
      h('div', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-msg', class: 'w-full max-w-sm space-y-4 rounded-2xl bg-slate-800 p-5 text-slate-100 shadow-2xl ring-1 ring-slate-600' },
        h('h2', { id: 'confirm-title', class: 'text-lg font-semibold' }, title),
        h('p', { id: 'confirm-msg', class: 'text-sm text-slate-300' }, message),
        h('div', { class: 'flex justify-end gap-2' }, cancel, ok)));
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Tab') { // keep focus inside the window
        e.preventDefault();
        (document.activeElement === cancel ? ok : cancel).focus();
      }
    };
    function done(value) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    }
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    cancel.focus();
  });
}

/** The hamburger menu at the top of every page. "My player page" shows once Discord says who is logged in. */
function siteNav() {
  const item = (href, label, cls = 'px-4 py-2.5 text-sm text-slate-100') => {
    const here = location.pathname === href;
    return h('a', { href, class: `block ${cls} hover:bg-slate-700 ${here ? 'bg-slate-700/60 font-semibold' : ''}`, 'aria-current': here ? 'page' : null }, label);
  };
  const mine = h('div');
  const panel = h('nav', { id: 'site-menu', 'aria-label': 'Site', class: 'absolute right-0 top-full z-40 mt-2 hidden w-56 overflow-hidden rounded-xl bg-slate-800 py-1 shadow-2xl ring-1 ring-slate-600' },
    item('/', 'New draft'),
    item('/library', 'Cube library'),
    item('/players', 'Players'),
    mine,
    h('div', { class: 'my-1 border-t border-slate-700' }),
    item('/owner', 'Owner page', 'px-4 py-1.5 text-xs text-slate-400'));
  const button = h('button', { type: 'button', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'site-menu', class: 'rounded-lg p-2 text-slate-300 hover:bg-slate-800 hover:text-white' },
    h('span', { class: 'block h-0.5 w-5 bg-current' }), h('span', { class: 'mt-1 block h-0.5 w-5 bg-current' }), h('span', { class: 'mt-1 block h-0.5 w-5 bg-current' }));
  let loaded = false;
  const setOpen = (open) => {
    panel.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    if (open && !loaded) {
      loaded = true;
      getMe().then(({ player }) => { if (player) mine.replaceChildren(item(`/players/${player.id}`, 'My player page')); });
    }
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.classList.contains('hidden'));
  });
  document.addEventListener('click', (e) => { if (!panel.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) { setOpen(false); button.focus(); } });
  return h('header', { class: 'relative mx-auto flex max-w-3xl items-center justify-between' },
    h('a', { href: '/', class: 'text-sm font-semibold text-emerald-400 hover:text-emerald-300' }, 'Cube Draft Voting'),
    button, panel);
}

document.body.prepend(siteNav());
