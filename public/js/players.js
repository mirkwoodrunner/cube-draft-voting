(async function () {
  const app = document.getElementById('app');
  const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  let data;
  try {
    data = await api('/players');
  } catch (err) {
    return showError(app, err.message);
  }
  const th = (t, cls = '') => h('th', { class: `px-2 py-2 font-medium ${cls}` }, t);
  const td = (t, cls = '') => h('td', { class: `px-2 py-2 ${cls}` }, t);
  const table = (rows, link) => h('div', { class: 'overflow-x-auto rounded-2xl bg-slate-800 ring-1 ring-slate-700' },
    h('table', { class: 'w-full text-left text-sm' },
      h('thead', { class: 'text-slate-400' }, h('tr', null, th('Player'), th('Drafts', 'text-right'), th('Match W-L-D', 'text-right'), th('Win %', 'text-right'), th('Games', 'text-right'))),
      h('tbody', { class: 'divide-y divide-slate-700' },
        rows.map((p) => h('tr', null,
          td(link(p)),
          td(p.drafts, 'text-right'),
          td(`${p.w}-${p.l}-${p.d}`, 'text-right'),
          td(pct(p.matchWinRate), 'text-right'),
          td(`${p.gw}-${p.gl}`, 'text-right'))))));
  const unclaimed = data.unclaimed || [];
  app.replaceChildren(
    h('h1', { class: 'text-2xl font-bold text-emerald-400' }, 'Players'),
    h('p', { class: 'mb-5 mt-1 text-sm text-slate-400' }, 'Players who logged in with Discord. Records count drafts where they voted or were added while logged in, and drafts they claimed.'),
    data.players.length
      ? table(data.players, (p) => h('a', { href: `/players/${p.id}`, class: 'flex items-center gap-2 hover:underline' }, avatar(p), p.name))
      : h('p', { class: 'rounded-xl bg-slate-800 p-4 text-slate-300 ring-1 ring-slate-700' }, 'No one has logged in yet.'),
    unclaimed.length > 0 && h('h2', { class: 'mt-8 text-lg font-semibold' }, 'Not claimed yet'),
    unclaimed.length > 0 && h('p', { class: 'mb-3 mt-1 text-sm text-slate-400' }, 'Names that played without logging in, grouped ignoring capitals. If one is you, open it and claim it to add those drafts to your record.'),
    unclaimed.length > 0 && table(unclaimed, (p) => h('a', { href: `/players/name/${encodeURIComponent(p.name)}`, class: 'hover:underline' }, p.name)));
})();
