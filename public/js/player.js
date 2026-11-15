(async function () {
  const app = document.getElementById('app');
  const [, , kind, rawName] = location.pathname.split('/');
  // /players/:id is a Discord player. /players/name/:name is a name that played without logging in.
  const plainName = kind === 'name' ? decodeURIComponent(rawName || '') : null;
  const card = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
  const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  const day = (d) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const TEAM = ['Team A', 'Team B'];
  let data;
  try {
    data = await api(plainName !== null ? `/players/name/${encodeURIComponent(plainName)}` : `/players/${encodeURIComponent(kind)}`);
  } catch (err) {
    return showError(app, err.status === 404
      ? (plainName !== null ? 'No unclaimed drafts under this name. They may have been claimed already.' : 'This player was not found.')
      : err.message);
  }
  const { totals: t, drafts } = data;
  const displayName = plainName !== null ? data.name : data.player.name;
  const bar = await accountBar();
  const stat = (label, value) => h('div', null,
    h('div', { class: 'text-xs uppercase tracking-wide text-slate-400' }, label),
    h('div', { class: 'text-2xl font-bold text-slate-50' }, value));
  const teamDrafts = t.teamWon + t.teamLost + t.teamTied;

  // In claim mode each draft gets a tick box, all ticked to start.
  const picks = new Map();
  const canClaim = plainName !== null && data.me;
  const draftLine = (d) => h('div', { class: 'min-w-0 flex-1' },
    h('div', { class: 'flex flex-wrap justify-between gap-2' },
      h('span', { class: 'font-medium' }, d.title),
      h('span', { class: 'text-slate-400' }, day(d.date))),
    h('div', { class: 'text-slate-300' },
      [d.cubeName,
        d.team !== null ? TEAM[d.team] : null,
        `${d.w}-${d.l}-${d.d}`,
        d.teamResult ? `team ${d.teamResult}` : null,
        d.name !== displayName ? `as ${d.name}` : null].filter(Boolean).join(' · ')));
  const draftRow = (d) => {
    if (!canClaim) return h('li', { class: 'py-2' }, draftLine(d));
    const box = h('input', { type: 'checkbox', class: 'mt-1 h-4 w-4 shrink-0 accent-emerald-500', 'aria-label': `Claim ${d.title}` });
    box.checked = true;
    picks.set(d.sessionId, box);
    return h('li', { class: 'py-2' }, h('label', { class: 'flex cursor-pointer gap-3' }, box, draftLine(d)));
  };

  function claimCard() {
    if (!data.loginEnabled) return null;
    if (!data.me) {
      return card(
        h('h2', { class: 'font-semibold' }, 'Is this you?'),
        h('p', { class: 'text-sm text-slate-400' }, 'Log in with Discord to claim these drafts. They are added to your player record along with anything already tied to your account.'),
        h('a', { href: `/auth/discord?next=${encodeURIComponent(location.pathname)}`, class: 'inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500' }, 'Log in with Discord'));
    }
    const err = h('p', { class: 'hidden text-sm text-red-300', role: 'alert' });
    const go = h('button', { type: 'button', class: 'rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50', onclick: async () => {
      const sessionIds = [...picks].filter(([, box]) => box.checked).map(([id]) => id);
      err.classList.add('hidden');
      if (!sessionIds.length) {
        err.textContent = 'Tick at least one draft above.';
        err.classList.remove('hidden');
        return;
      }
      const n = sessionIds.length;
      if (!(await confirmDialog(`${n} draft${n === 1 ? '' : 's'} played as "${displayName}" will be added to ${data.me.name}'s record. Only claim drafts you actually played.`, { title: 'Claim these drafts?', confirmLabel: 'Claim', danger: false }))) return;
      go.disabled = true;
      try {
        const out = await api(`/players/name/${encodeURIComponent(plainName)}/claim`, { method: 'POST', body: { sessionIds } });
        if (out.skipped.length) alert(`Skipped because you are already in that draft under another name: ${out.skipped.join(', ')}`);
        location.href = `/players/${out.playerId}`;
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        go.disabled = false;
      }
    } }, `Claim as ${data.me.name}`);
    return card(
      h('h2', { class: 'font-semibold' }, 'Is this you?'),
      h('p', { class: 'text-sm text-slate-400' }, 'Untick any draft above that was someone else with the same name, then claim the rest. They are merged into your record.'),
      err, go);
  }

  const header = plainName !== null
    ? h('div', { class: 'mb-5' },
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, displayName),
        h('span', { class: 'rounded-full bg-slate-700 px-2 py-0.5 text-[11px] font-semibold text-slate-200' }, 'Not claimed')),
      h('p', { class: 'text-sm text-slate-400' }, 'Drafts played under this name without a Discord login.'))
    : h('div', { class: 'mb-5 flex items-center gap-3' },
      avatar(data.player, 'h-14 w-14'),
      h('div', null,
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, displayName),
        h('p', { class: 'text-sm text-slate-400' }, `Player since ${day(data.player.since)}`)));

  app.replaceChildren(
    bar,
    header,
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
          ? h('ul', { class: 'divide-y divide-slate-700 text-sm' }, drafts.map(draftRow))
          : h('p', { class: 'text-sm text-slate-400' }, 'No drafts yet.')),
      plainName !== null && claimCard(),
      plainName === null && data.isMe && card(
        h('h2', { class: 'font-semibold' }, 'Delete my profile'),
        h('p', { class: 'text-sm text-slate-400' }, 'Removes this page and your login. Your name stays in past drafts as a plain name, and those drafts no longer count toward any record.'),
        h('button', { type: 'button', class: 'rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600', onclick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog('Your player page and login are deleted for good.', { title: 'Delete your profile?', confirmLabel: 'Delete' }))) return;
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
