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

/** Name, author, card count, tags and link for a cube. Duplicate names also show the full URL. */
function cubeInfo(cube, dupes) {
  const isDupe = dupes.has(cube.name.trim().toLowerCase());
  const facts = [cube.author ? `by ${cube.author}` : null, cube.cardCount != null ? `${cube.cardCount} cards` : null].filter(Boolean);
  const shortUrl = cube.url ? cube.url.replace(/^https?:\/\//, '') : null;
  return h('div', { class: 'min-w-0' },
    h('div', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: 'font-semibold text-slate-50 break-words' }, cube.name),
      isDupe && h('span', { class: 'rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-300' }, 'same name as another cube')),
    facts.length > 0 && h('div', { class: 'text-sm text-slate-300' }, facts.join(' · ')),
    cube.tags && cube.tags.length > 0 && h('div', { class: 'mt-1 flex flex-wrap gap-1' },
      cube.tags.map((t) => h('span', { class: 'rounded-full bg-slate-700 px-2 py-0.5 text-[11px] text-slate-200' }, t))),
    cube.url && h('a', { href: cube.url, target: '_blank', rel: 'noopener noreferrer', class: `mt-1 block break-all text-xs text-sky-400 hover:underline` },
      isDupe ? shortUrl : 'View on Cube Cobra'));
}

function showError(container, message) {
  container.replaceChildren(h('div', { class: 'rounded-xl bg-red-900/40 p-4 text-red-200 ring-1 ring-red-700' }, message));
}
