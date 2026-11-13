/**
 * Results section of the admin dashboard: pods, moving players, teams,
 * match results and standings. `act(path, button, opts)` runs an admin API
 * call and redraws the dashboard.
 */
const TEAM_NAMES = ['Team A', 'Team B'];
const TEAM_STYLE = ['bg-sky-600/30 text-sky-200', 'bg-rose-600/30 text-rose-200'];

const rCard = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
const rPct = (x) => `${Math.round(x * 100)}%`;
const miniBtn = (cls, label, onclick, attrs = {}) => h('button', { type: 'button', class: `rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${cls}`, onclick, ...attrs }, label);
const scoreInput = (value, label) => h('input', {
  type: 'number', min: 0, max: 9, inputmode: 'numeric', value: value ?? '', 'aria-label': label,
  class: 'w-12 rounded-md bg-slate-900 px-2 py-1 text-center text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500'
});
const smallSelect = (label, options, extra = '') => h('select', { 'aria-label': label, class: `rounded-md bg-slate-900 px-2 py-1 text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500 ${extra}` }, options);
const teamBadge = (t) => h('span', { class: `rounded-full px-2 py-0.5 text-[11px] font-semibold ${TEAM_STYLE[t]}` }, TEAM_NAMES[t]);
const isPlayed = (m) => m.w1 !== null && m.w1 !== undefined;

/** "Move to" dropdown for one player. */
function moveSelect(d, name, currentCubeId, act) {
  const options = [h('option', { value: '' }, 'Move to...')];
  for (const c of d.cubes) {
    if (String(c.id) === currentCubeId) continue;
    const pod = d.results.pods.find((p) => p.cubeId === String(c.id));
    options.push(h('option', { value: String(c.id) }, `${c.name} (${pod ? pod.players.length : 0}/${c.maxPlayers})`));
  }
  if (currentCubeId !== null) options.push(h('option', { value: '__out' }, 'Out of the pods'));
  options.push(h('option', { value: '__remove' }, 'Remove from draft'));
  const sel = smallSelect(`Move ${name}`, options, 'max-w-[11rem]');
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    if (sel.value === '__remove') {
      const voted = d.voters.some((v) => v.name === name);
      if (confirm(`Remove ${name} from the draft?${voted ? ' Their ballot is deleted too.' : ''} Unplayed pairings for them are dropped. Results they already played are kept.`)) {
        act('/pods/remove', sel, { body: { name } });
      } else sel.value = '';
      return;
    }
    const cubeId = sel.value === '__out' ? null : sel.value;
    act('/pods/move', sel, { body: { name, cubeId } });
  });
  return sel;
}

function playerRow(d, pod, p, act) {
  const teamMode = d.session.teamMode;
  return h('li', { class: 'flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm' },
    h('span', { class: 'flex items-center gap-2' },
      h('span', null, p.name),
      p.late
        ? h('span', { class: 'rounded-full bg-violet-600/30 px-2 py-0.5 text-xs text-violet-200' }, 'joined late')
        : h('span', { class: `rounded-full px-2 py-0.5 text-xs ${p.rank === 1 ? 'bg-emerald-600/30 text-emerald-300' : 'bg-slate-700 text-slate-300'}` }, `${ordinal(p.rank)} choice`)),
    h('span', { class: 'flex items-center gap-1.5' },
      teamMode && miniBtn('bg-slate-700 hover:bg-slate-600', `To ${TEAM_NAMES[p.team === 1 ? 0 : 1]}`, (e) => act('/pods/switch-team', e.currentTarget, { body: { name: p.name } })),
      moveSelect(d, p.name, pod.cubeId, act)));
}

function podWarnings(d, pod) {
  const n = pod.players.length;
  const out = [];
  if (n < pod.minPlayers) out.push(`Below this cube's minimum of ${pod.minPlayers}`);
  if (n > pod.maxPlayers) out.push(`Above this cube's maximum of ${pod.maxPlayers}`);
  if (d.session.teamMode) {
    const a = pod.players.filter((p) => p.team === 0).length;
    if (Math.abs(a - (n - a)) > 1) out.push(`Teams are uneven (${a} vs ${n - a})`);
    else if (n % 2 === 1) out.push('Odd number of players, so someone sits out each round');
  }
  return out;
}

// ---------- matches ----------

function matchRow(d, m, act) {
  const w1 = scoreInput(m.w1, `${m.p1} games won`);
  const w2 = scoreInput(m.w2, `${m.p2} games won`);
  const dr = scoreInput(isPlayed(m) ? m.d : '', 'Drawn games');
  const winner = isPlayed(m) ? (m.w1 > m.w2 ? 1 : m.w2 > m.w1 ? 2 : 0) : -1;
  const nameCls = (side) => `min-w-0 flex-1 truncate ${winner === side ? 'font-semibold text-emerald-300' : ''}`;
  const save = miniBtn('bg-emerald-600 hover:bg-emerald-500', isPlayed(m) ? 'Update' : 'Save', (e) =>
    act(`/matches/${encodeURIComponent(m.id)}`, e.currentTarget, { method: 'PUT', body: { w1: w1.value, w2: w2.value, d: dr.value } }));
  const del = miniBtn('bg-slate-700 hover:bg-red-600', '✕', (e) => {
    if (confirm(`Delete the round ${m.round} match ${m.p1} vs ${m.p2}?`)) act(`/matches/${encodeURIComponent(m.id)}`, e.currentTarget, { method: 'DELETE' });
  }, { 'aria-label': 'Delete match', title: 'Delete match' });
  return h('div', { class: `space-y-2 rounded-lg p-2.5 ${isPlayed(m) ? 'bg-slate-900/50' : 'border border-dashed border-slate-600 bg-slate-900/30'}` },
    h('div', { class: 'flex items-center gap-2 text-sm' },
      h('span', { class: `${nameCls(1)} text-right` }, m.p1), w1,
      h('span', { class: 'text-slate-500' }, '-'),
      w2, h('span', { class: nameCls(2) }, m.p2)),
    h('div', { class: 'flex items-center justify-end gap-2 text-xs text-slate-400' },
      h('label', { class: 'flex items-center gap-1' }, 'Draws', dr),
      save, del));
}

function addMatchForm(d, pod, matches, act) {
  const teamMode = d.session.teamMode;
  const lastRound = matches.reduce((mx, m) => Math.max(mx, m.round), 0);
  const round = h('input', { type: 'number', min: 1, max: 20, value: Math.max(1, lastRound), 'aria-label': 'Round', class: 'w-14 rounded-md bg-slate-900 px-2 py-1 text-center text-sm ring-1 ring-slate-600' });
  const opts = (team) => [h('option', { value: '' }, team === null ? 'Player' : `${TEAM_NAMES[team]} player`),
    ...pod.players.filter((p) => team === null || p.team === team).map((p) => h('option', { value: p.name }, p.name))];
  const p1 = smallSelect('First player', opts(teamMode ? 0 : null), 'min-w-0 flex-1');
  const p2 = smallSelect('Second player', opts(teamMode ? 1 : null), 'min-w-0 flex-1');
  const w1 = scoreInput('', 'First player games won');
  const w2 = scoreInput('', 'Second player games won');
  const dr = scoreInput('', 'Drawn games');
  const add = miniBtn('bg-sky-600 hover:bg-sky-500', 'Add match', (e) => {
    if (!p1.value || !p2.value) { alert('Pick both players'); return; }
    act('/matches', e.currentTarget, { body: { cubeId: pod.cubeId, round: round.value, p1: p1.value, p2: p2.value, w1: w1.value, w2: w2.value, d: dr.value } });
  });
  return h('details', { class: 'rounded-lg bg-slate-900/40 p-3' },
    h('summary', { class: 'cursor-pointer text-sm font-medium text-slate-200' }, 'Add a match'),
    h('div', { class: 'mt-3 space-y-2' },
      h('div', { class: 'flex items-center gap-2' }, p1, w1, h('span', { class: 'text-slate-500' }, '-'), w2, p2),
      h('div', { class: 'flex flex-wrap items-center justify-end gap-2 text-xs text-slate-400' },
        h('label', { class: 'flex items-center gap-1' }, 'Round', round),
        h('label', { class: 'flex items-center gap-1' }, 'Draws', dr),
        add),
      h('p', { class: 'text-xs text-slate-500' }, 'Leave the scores blank to add the pairing now and enter the result later.')));
}

function pairingsForm(pod, matches, act) {
  if (matches.some(isPlayed)) return null;
  const a = pod.players.filter((p) => p.team === 0).length;
  const n = Math.max(a, pod.players.length - a);
  if (!a || a === pod.players.length) return null;
  const rounds = h('input', { type: 'number', min: 1, max: n, value: Math.min(3, n), 'aria-label': 'Rounds', class: 'w-14 rounded-md bg-slate-900 px-2 py-1 text-center text-sm ring-1 ring-slate-600' });
  const go = miniBtn('bg-sky-600 hover:bg-sky-500', matches.length ? 'Regenerate pairings' : 'Generate pairings', (e) => {
    if (matches.length && !confirm('Replace the current pairings?')) return;
    act(`/pods/${encodeURIComponent(pod.cubeId)}/pairings`, e.currentTarget, { body: { rounds: rounds.value } });
  });
  return h('div', { class: 'flex flex-wrap items-center gap-2 text-xs text-slate-400' },
    h('label', { class: 'flex items-center gap-1' }, 'Rounds', rounds), go,
    h('span', null, `Each player meets a different opponent from the other team every round (up to ${n}).`));
}

function standingsTable(st, teamMode) {
  if (!st.played) return null;
  const th = (t, cls = '') => h('th', { class: `px-1.5 py-1 font-medium ${cls}` }, t);
  const td = (t, cls = '') => h('td', { class: `px-1.5 py-1 ${cls}` }, t);
  return h('div', { class: 'overflow-x-auto' },
    h('table', { class: 'w-full text-left text-xs' },
      h('thead', { class: 'text-slate-400' }, h('tr', null, th('Player'), teamMode && th('Team'), th('Match W-L-D', 'text-right'), th('Games', 'text-right'), th('Points', 'text-right'))),
      h('tbody', { class: 'divide-y divide-slate-700' },
        st.players.map((p) => h('tr', null,
          td(p.name),
          teamMode && td(p.team === null ? '' : TEAM_NAMES[p.team]),
          td(`${p.w}-${p.l}-${p.d}`, 'text-right'),
          td(`${p.gw}-${p.gl}`, 'text-right'),
          td(p.points, 'text-right font-semibold'))))));
}

function matchesBlock(d, pod, act) {
  const teamMode = d.session.teamMode;
  const matches = (d.results.matches || []).filter((m) => m.cubeId === pod.cubeId).sort((a, b) => a.round - b.round);
  const st = d.standings[pod.cubeId];
  const rounds = [...new Set(matches.map((m) => m.round))];
  return h('div', { class: 'space-y-3 border-t border-slate-700 pt-3' },
    h('div', { class: 'flex flex-wrap items-baseline justify-between gap-2' },
      h('h3', { class: 'text-sm font-semibold text-slate-200' }, 'Matches'),
      teamMode && st.teamScore && h('div', { class: 'text-sm font-semibold' },
        h('span', { class: 'text-sky-300' }, `${TEAM_NAMES[0]} ${st.teamScore[0]}`),
        h('span', { class: 'px-1.5 text-slate-500' }, '-'),
        h('span', { class: 'text-rose-300' }, `${st.teamScore[1]} ${TEAM_NAMES[1]}`))),
    teamMode && pairingsForm(pod, matches, act),
    rounds.map((r) => h('div', { class: 'space-y-1.5' },
      h('div', { class: 'text-xs font-semibold uppercase tracking-wide text-slate-400' }, `Round ${r}`),
      matches.filter((m) => m.round === r).map((m) => matchRow(d, m, act)))),
    addMatchForm(d, pod, matches, act),
    standingsTable(st, teamMode));
}

// ---------- pods ----------

function podCard(d, pod, dupes, act) {
  const teamMode = d.session.teamMode;
  const warnings = podWarnings(d, pod);
  const list = (players) => h('ul', { class: 'divide-y divide-slate-700' }, players.map((p) => playerRow(d, pod, p, act)));
  return rCard(
    h('div', { class: 'flex items-start justify-between gap-3' },
      cubeInfo(pod, dupes),
      h('div', { class: 'shrink-0 text-right' },
        h('div', { class: 'text-2xl font-bold text-emerald-400' }, rPct(pod.satisfaction)),
        h('div', { class: 'text-xs text-slate-400' }, `${pod.players.length} players (${pod.minPlayers}-${pod.maxPlayers})`))),
    warnings.length > 0 && h('ul', { class: 'list-disc pl-5 text-xs text-amber-300' }, warnings.map((w) => h('li', null, w))),
    teamMode
      ? [0, 1].map((t) => h('div', null,
        h('div', { class: 'mb-1 flex items-center gap-2' }, teamBadge(t), h('span', { class: 'text-xs text-slate-400' }, `${pod.players.filter((p) => p.team === t).length} players, drafts at its own table`)),
        list(pod.players.filter((p) => p.team === t))))
      : list(pod.players),
    matchesBlock(d, pod, act));
}

/** Adds someone who didn't vote straight into a pod. */
function addPlayerForm(d, act) {
  const name = h('input', { maxlength: 40, placeholder: 'Name', 'aria-label': 'New player name', class: 'min-w-0 flex-1 rounded-md bg-slate-900 px-2 py-1 text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500' });
  const pod = smallSelect('Pod for the new player', [
    ...d.cubes.map((c) => {
      const p = d.results.pods.find((x) => x.cubeId === String(c.id));
      return h('option', { value: String(c.id) }, `${c.name} (${p ? p.players.length : 0}/${c.maxPlayers})`);
    }),
    h('option', { value: '' }, 'Not in a pod yet')
  ], 'min-w-0 max-w-[12rem]');
  const first = d.results.pods[0];
  if (first) pod.value = first.cubeId;
  const add = miniBtn('bg-sky-600 hover:bg-sky-500', 'Add player', (e) => {
    if (!name.value.trim()) { alert('Enter a name'); return; }
    act('/pods/add', e.currentTarget, { body: { name: name.value, cubeId: pod.value || null } });
  });
  return h('details', { class: 'rounded-lg bg-slate-900/40 p-3' },
    h('summary', { class: 'cursor-pointer text-sm font-medium text-slate-200' }, 'Add a player who joined after voting'),
    h('div', { class: 'mt-3 space-y-2' },
      h('div', { class: 'flex flex-wrap items-center gap-2' }, name, pod, add),
      h('p', { class: 'text-xs text-slate-500' }, `They have no ballot, so they're left out of the happiness score.${d.session.teamMode ? ' They join the smaller team.' : ''} Re-running the assignment or reopening voting drops them.`)));
}

function resultsView(d, dupes, act) {
  const { results } = d;
  const s = results.stats;
  const dist = Object.keys(s.rankCounts).map(Number).sort((a, b) => a - b)
    .map((r) => `${s.rankCounts[r]} got their ${ordinal(r)} choice`).join(' · ');
  return [
    rCard(
      h('div', { class: 'flex flex-wrap items-end gap-x-6 gap-y-2' },
        h('div', null,
          h('div', { class: 'text-xs uppercase tracking-wide text-slate-400' }, 'Group happiness'),
          h('div', { class: 'text-5xl font-bold text-emerald-400' }, rPct(s.groupSatisfaction))),
        h('div', { class: 'text-sm text-slate-300' },
          h('div', null, `${s.seated} of ${s.players} players seated in ${results.pods.length} pod${results.pods.length === 1 ? '' : 's'}`),
          dist && h('div', null, dist))),
      h('p', { class: 'text-xs text-slate-500' }, '100% means every seated player got their first choice and 0% means every one got their last. Unassigned players and late joiners are not counted.'),
      results.edited && h('p', { class: 'text-xs text-amber-300' }, 'You have changed these pods by hand. Re-running the assignment replaces your changes.'),
      h('p', { class: 'text-xs text-slate-400' }, 'Use "Move to" on any player to change pods or remove them from the draft.', d.session.teamMode ? ' Use the team button to swap a player to the other team.' : ''),
      addPlayerForm(d, act)),
    results.pods.map((p) => podCard(d, p, dupes, act)),
    results.unassigned.length > 0 && rCard(
      h('h3', { class: 'font-semibold text-amber-300' }, `Unassigned (${results.unassigned.length}), needs your review`),
      h('ul', { class: 'divide-y divide-slate-700 text-sm' },
        results.unassigned.map((u) => h('li', { class: 'flex flex-wrap items-center justify-between gap-2 py-1.5' },
          h('div', null, h('span', { class: 'font-medium' }, u.name), u.late && h('span', { class: 'ml-2 rounded-full bg-violet-600/30 px-2 py-0.5 text-xs text-violet-200' }, 'joined late'), h('span', { class: 'block text-xs text-slate-400' }, u.reason)),
          moveSelect(d, u.name, null, act))))),
    results.notFired.length > 0 && rCard(
      h('h3', { class: 'font-semibold text-slate-300' }, 'Cubes that did not fire'),
      results.notFired.map((c) => h('div', { class: 'rounded-lg bg-slate-900/50 p-3' },
        cubeInfo(c, dupes),
        h('p', { class: 'mt-1 text-xs text-slate-400' }, `${c.reason}. ${c.firstChoiceVotes} first-choice vote${c.firstChoiceVotes === 1 ? '' : 's'}.`))))
  ];
}

/** Every voter's ranking, kept as the record of how people voted. */
function ballotsView(d) {
  const byId = new Map(d.cubes.map((c) => [Number(c.id), c.name]));
  if (!d.voters.length) return null;
  return rCard(
    h('details', null,
      h('summary', { class: 'cursor-pointer font-semibold' }, `Ballots (${d.voters.length})`),
      h('div', { class: 'mt-3 space-y-2' },
        d.voters.map((v) => h('div', { class: 'rounded-lg bg-slate-900/50 p-3 text-sm' },
          h('div', { class: 'font-medium' }, v.name, v.you && h('span', { class: 'ml-1 text-slate-400' }, '(you)'),
            h('span', { class: 'ml-2 text-xs font-normal text-slate-500' }, `last changed ${new Date(v.updatedAt).toLocaleString()}`)),
          h('ol', { class: 'mt-1 list-decimal pl-5 text-slate-300' },
            v.preferences.map((id) => h('li', null, byId.get(Number(id)) || 'Removed cube'))))))));
}
