(function () {
  const app = document.getElementById('app');
  const token = location.pathname.split('/')[2];
  const base = `/admin/${encodeURIComponent(token)}`;
  let last = '';
  let timer = null;
  let busy = false;

  const pct = (x) => `${Math.round(x * 100)}%`;
  const card = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
  const STATUS = { open: ['Voting open', 'bg-emerald-600'], closed: ['Voting closed', 'bg-amber-600'], assigned: ['Pods assigned', 'bg-sky-600'] };

  async function act(path, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      render(await api(`${base}${path}`, { method: 'POST' }));
    } catch (err) {
      alert(err.message);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  function podCard(pod, dupes) {
    return card(
      h('div', { class: 'flex items-start justify-between gap-3' },
        cubeInfo(pod, dupes),
        h('div', { class: 'shrink-0 text-right' },
          h('div', { class: 'text-2xl font-bold text-emerald-400' }, pct(pod.satisfaction)),
          h('div', { class: 'text-xs text-slate-400' }, `${pod.players.length} players (${pod.minPlayers}-${pod.maxPlayers})`))),
      h('ul', { class: 'divide-y divide-slate-700' },
        pod.players.map((p) => h('li', { class: 'flex items-center justify-between py-1.5 text-sm' },
          h('span', null, p.name),
          h('span', { class: `rounded-full px-2 py-0.5 text-xs ${p.rank === 1 ? 'bg-emerald-600/30 text-emerald-300' : 'bg-slate-700 text-slate-300'}` }, `${ordinal(p.rank)} choice`)))));
  }

  function resultsView(results, dupes) {
    const s = results.stats;
    const dist = Object.keys(s.rankCounts).map(Number).sort((a, b) => a - b)
      .map((r) => `${s.rankCounts[r]} got their ${ordinal(r)} choice`).join(' · ');
    return [
      card(
        h('div', { class: 'flex flex-wrap items-end gap-x-6 gap-y-2' },
          h('div', null,
            h('div', { class: 'text-xs uppercase tracking-wide text-slate-400' }, 'Group happiness'),
            h('div', { class: 'text-5xl font-bold text-emerald-400' }, pct(s.groupSatisfaction))),
          h('div', { class: 'text-sm text-slate-300' },
            h('div', null, `${s.seated} of ${s.players} players seated in ${results.pods.length} pod${results.pods.length === 1 ? '' : 's'}`),
            dist && h('div', null, dist))),
        h('p', { class: 'text-xs text-slate-500' }, '100% means every seated player got their first choice and 0% means every one got their last. Unassigned players are not counted.')),
      results.pods.map((p) => podCard(p, dupes)),
      results.unassigned.length > 0 && card(
        h('h3', { class: 'font-semibold text-amber-300' }, `Unassigned (${results.unassigned.length}) — needs your review`),
        h('ul', { class: 'divide-y divide-slate-700 text-sm' },
          results.unassigned.map((u) => h('li', { class: 'py-1.5' }, h('span', { class: 'font-medium' }, u.name), h('span', { class: 'block text-xs text-slate-400' }, u.reason))))),
      results.notFired.length > 0 && card(
        h('h3', { class: 'font-semibold text-slate-300' }, 'Cubes that did not fire'),
        results.notFired.map((c) => h('div', { class: 'rounded-lg bg-slate-900/50 p-3' },
          cubeInfo(c, dupes),
          h('p', { class: 'mt-1 text-xs text-slate-400' }, `${c.reason}. ${c.firstChoiceVotes} first-choice vote${c.firstChoiceVotes === 1 ? '' : 's'}.`))))
    ];
  }

  function render(d) {
    const json = JSON.stringify(d);
    if (json === last) return;
    last = json;
    const { session, cubes, voteCount, voters, results } = d;
    const dupes = duplicateNames(cubes);
    const [statusText, statusColor] = STATUS[session.status] || STATUS.open;

    const closeBtn = h('button', { class: 'w-full rounded-xl bg-red-600 px-4 py-4 text-xl font-bold text-white hover:bg-red-500 disabled:opacity-50', onclick: (e) => {
      if (confirm(`Close voting now? ${voteCount} vote${voteCount === 1 ? '' : 's'} so far. Players will no longer be able to vote or change their ballots.`)) act('/close', e.currentTarget);
    } }, 'Close Voting');
    const assignBtn = h('button', { class: 'w-full rounded-xl bg-emerald-600 px-4 py-4 text-xl font-bold text-white hover:bg-emerald-500 disabled:opacity-50', onclick: (e) => act('/assign', e.currentTarget) },
      session.status === 'assigned' ? 'Re-run assignment' : 'Assign pods');

    app.replaceChildren(
      h('div', { class: 'mb-4 flex flex-wrap items-center gap-3' },
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, session.title),
        h('span', { class: `rounded-full px-3 py-1 text-xs font-semibold text-white ${statusColor}` }, statusText)),
      h('div', { class: 'space-y-4' },
        card(
          linkBox('Player Voting Link', 'Share this with your players.', `/vote/${session.id}`, 'emerald'),
          linkBox('Admin Dashboard Link', 'Keep this private. It controls the session.', base, 'amber')),
        card(
          h('div', { class: 'flex items-baseline gap-3' },
            h('div', { class: 'text-5xl font-bold' }, voteCount),
            h('div', { class: 'text-slate-300' }, `vote${voteCount === 1 ? '' : 's'} in`,
              session.status === 'open' && h('span', { class: 'ml-2 text-xs text-slate-500' }, 'updates automatically'))),
          voters.length > 0 && h('div', { class: 'flex flex-wrap gap-1.5' },
            voters.map((v) => h('span', { class: 'rounded-full bg-slate-700 px-2.5 py-1 text-xs' }, v.name))),
          session.status === 'open' && closeBtn,
          session.status !== 'open' && assignBtn),
        card(
          h('h2', { class: 'font-semibold' }, `Cubes (${cubes.length})`),
          cubes.map((c) => h('div', { class: 'flex items-start justify-between gap-3 rounded-lg bg-slate-900/50 p-3' },
            cubeInfo(c, dupes),
            h('div', { class: 'shrink-0 text-right text-xs text-slate-400' }, `${c.minPlayers}-${c.maxPlayers}`, h('br'), 'players')))),
        results && h('h2', { class: 'pt-2 text-xl font-bold' }, 'Results'),
        results && resultsView(results, dupes)));

    // Poll only while votes can still change.
    clearInterval(timer);
    if (session.status === 'open') timer = setInterval(refresh, 5000);
  }

  async function refresh() {
    if (document.hidden || busy) return;
    try { render(await api(base)); } catch { /* keep the last view; try again next tick */ }
  }

  api(base).then(render).catch((err) => showError(app, err.status === 404 ? 'This admin link is not valid.' : err.message));
})();
