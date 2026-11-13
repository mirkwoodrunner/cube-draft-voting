(async function () {
  const app = document.getElementById('app');
  const id = location.pathname.split('/')[2];
  const card = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
  const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  const TEAM = ['Team A', 'Team B'];
  let data;
  try {
    data = await api(`/players/${encodeURIComponent(id)}`);
  } catch (err) {
    return showError(app, err.status === 404 ? 'This player was not found.' : err.message);
  }
  const { player, totals: t, drafts, isMe } = data;
  const bar = await accountBar();
  const stat = (label, value) => h('div', null,
    h('div', { class: 'text-xs uppercase tracking-wide text-slate-400' }, label),
    h('div', { class: 'text-2xl font-bold text-slate-50' }, value));
  const teamDrafts = t.teamWon + t.teamLost + t.teamTied;

  app.replaceChildren(
    bar,
    h('div', { class: 'mb-5 flex items-center gap-3' },
      avatar(player, 'h-14 w-14'),
      h('div', null,
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, player.name),
        h('p', { class: 'text-sm text-slate-400' }, `Player since ${new Date(player.since).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`))),
    h('div', { class: 'space-y-4' },
      card(h('div', { class: 'grid grid-cols-2 gap-4 sm:grid-cols-4' },
        stat('Drafts', t.drafts),
        stat('Match W-L-D', `${t.w}-${t.l}-${t.d}`),
        stat('Match win %', pct(t.matchWinRate)),
        stat('Games', `${t.gw}-${t.gl}`)),
      teamDrafts > 0 && h('p', { class: 'text-sm text-slate-300' }, `Team drafts ${t.teamWon} won, ${t.teamLost} lost${t.teamTied ? `, ${t.teamTied} tied` : ''}`)),
      t.cubes.length > 0 && card(
        h('h2', { class: 'font-semibold' }, 'Cubes drafted'),
        h('ul', { class: 'divide-y divide-slate-700 text-sm' }, t.cubes.map((c) => h('li', { class: 'flex justify-between gap-3 py-1.5' },
          c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', class: 'text-sky-400 hover:underline' }, c.name) : h('span', null, c.name),
          h('span', { class: 'text-slate-400' }, `${c.drafts}x`))))),
      card(
        h('h2', { class: 'font-semibold' }, 'Drafts'),
        drafts.length
          ? h('ul', { class: 'divide-y divide-slate-700 text-sm' }, drafts.map((d) => h('li', { class: 'py-2' },
            h('div', { class: 'flex flex-wrap justify-between gap-2' },
              h('span', { class: 'font-medium' }, d.title),
              h('span', { class: 'text-slate-400' }, new Date(d.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))),
            h('div', { class: 'text-slate-300' },
              [d.cubeName,
                d.team !== null ? TEAM[d.team] : null,
                `${d.w}-${d.l}-${d.d}`,
                d.teamResult ? `team ${d.teamResult}` : null,
                d.name !== player.name ? `as ${d.name}` : null].filter(Boolean).join(' · ')))))
          : h('p', { class: 'text-sm text-slate-400' }, 'No drafts yet.')),
      isMe && card(
        h('h2', { class: 'font-semibold' }, 'Delete my profile'),
        h('p', { class: 'text-sm text-slate-400' }, 'Removes this page and your login. Your name stays in past drafts as a plain name, and those drafts no longer count toward any record.'),
        h('button', { type: 'button', class: 'rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600', onclick: async (e) => {
          const btn = e.currentTarget;
          if (!confirm('Delete your player profile for good?')) return;
          btn.disabled = true;
          try {
            await api('/me', { method: 'DELETE' });
            location.href = '/players';
          } catch (err) {
            alert(err.message);
            btn.disabled = false;
          }
        } }, 'Delete my profile'))));
})();
