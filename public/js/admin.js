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

  const store = storage();
  const nameKey = `cube-admin-name:${token}`;
  let data = null;
  let editing = false;
  let keepVoteForm = false; // set after the admin saves a ballot, so the form and its confirmation stay put
  const keys = {};
  const slots = {
    top: h('div', { class: 'space-y-4' }),
    vote: h('div'),
    cubes: h('div'),
    results: h('div', { class: 'space-y-4' })
  };

  const btn = (cls, label, onclick) => h('button', { class: `w-full rounded-xl px-4 py-4 text-xl font-bold text-white disabled:opacity-50 ${cls}`, onclick }, label);
  const smallBtn = (cls, label, onclick) => h('button', { type: 'button', class: `rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 ${cls}`, onclick }, label);

  /** Runs an admin action and redraws from the dashboard the server sends back. */
  async function act(path, button, { method = 'POST', body } = {}) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try {
      render(await api(`${base}${path}`, { method, body }));
    } catch (err) {
      alert(err.message);
    } finally {
      busy = false;
      if (button) button.disabled = false;
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

  // ---------- top: links, votes, controls ----------

  function topView(d) {
    const { session, voteCount, voters } = d;
    const [statusText, statusColor] = STATUS[session.status] || STATUS.open;
    const open = session.status === 'open';
    const plural = `${voteCount} vote${voteCount === 1 ? '' : 's'}`;

    return [
      h('div', { class: 'flex flex-wrap items-center gap-3' },
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, session.title),
        h('span', { class: `rounded-full px-3 py-1 text-xs font-semibold text-white ${statusColor}` }, statusText)),
      card(
        linkBox('Player Voting Link', 'Share this with your players.', `/vote/${session.id}`, 'emerald'),
        linkBox('Admin Dashboard Link', 'Keep this private. It controls the session.', base, 'amber')),
      card(
        h('div', { class: 'flex items-baseline gap-3' },
          h('div', { class: 'text-5xl font-bold' }, voteCount),
          h('div', { class: 'text-slate-300' }, `vote${voteCount === 1 ? '' : 's'} in`,
            open && h('span', { class: 'ml-2 text-xs text-slate-500' }, 'updates automatically'))),
        voters.length > 0 && h('div', { class: 'flex flex-wrap gap-1.5' },
          voters.map((v) => h('span', { class: 'inline-flex items-center gap-1 rounded-full bg-slate-700 py-1 pl-2.5 pr-1 text-xs' },
            v.name, v.you && h('span', { class: 'text-slate-400' }, '(you)'),
            h('button', {
              type: 'button', 'aria-label': `Remove ${v.name}'s vote`, title: 'Remove this vote',
              class: 'flex h-5 w-5 items-center justify-center rounded-full text-slate-300 hover:bg-red-600 hover:text-white',
              onclick: (e) => {
                const extra = session.status === 'assigned' ? ' The pod assignment will be cleared and voting set back to closed.' : '';
                if (confirm(`Remove ${v.name}'s vote?${extra}`)) act(`/voters/${v.id}`, e.currentTarget, { method: 'DELETE' });
              }
            }, '✕')))),
        open && btn('bg-red-600 hover:bg-red-500', 'Close Voting', (e) => {
          if (confirm(`Close voting now? ${plural} so far. Players will no longer be able to vote or change their ballots.`)) act('/close', e.currentTarget);
        }),
        !open && btn('bg-emerald-600 hover:bg-emerald-500', session.status === 'assigned' ? 'Re-run assignment' : 'Assign pods', (e) => act('/assign', e.currentTarget)),
        !open && h('button', { class: 'w-full rounded-xl bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50', onclick: (e) => {
          const extra = session.status === 'assigned' ? ' The current pod assignment will be cleared.' : '';
          if (confirm(`Reopen voting? Players will be able to vote and change their ballots again.${extra}`)) act('/reopen', e.currentTarget);
        } }, 'Reopen voting'))
    ];
  }

  // ---------- admin's own ballot ----------

  async function voteView(d) {
    const { session, cubes } = d;
    const open = session.status === 'open';
    let ballot = null;
    try { ({ ballot } = await api(`${base}/ballot`)); } catch { /* treat as no ballot */ }

    if (!open) {
      return card(
        h('h2', { class: 'font-semibold' }, 'Your vote'),
        h('p', { class: 'text-sm text-slate-400' }, ballot ? `You voted as ${ballot.playerName}. Reopen voting to change it.` : 'You are not playing in this draft.'));
    }

    const body = h('div', { class: 'space-y-4' });
    const msg = h('div', { class: 'hidden rounded-xl p-3 text-sm', role: 'status' });
    const notice = (kind, text) => {
      msg.className = `rounded-xl p-3 text-sm ring-1 ${kind === 'ok' ? 'bg-emerald-900/40 text-emerald-200 ring-emerald-700' : 'bg-red-900/40 text-red-200 ring-red-700'}`;
      msg.textContent = text;
    };

    const toggle = h('input', { type: 'checkbox', id: 'playing', checked: Boolean(ballot), class: 'h-5 w-5 accent-emerald-500' });

    function showForm() {
      const ranking = rankList(cubes, ballot ? orderFromBallot(cubes, ballot.preferences) : shuffle(cubes.map((c) => String(c.id))));
      const nameInput = h('input', { required: true, maxlength: 40, value: ballot ? ballot.playerName : (store.get(nameKey) || ''), placeholder: 'Your name', class: 'mt-1 w-full rounded-lg bg-slate-900 px-3 py-2 ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500' });
      const save = h('button', { class: 'w-full rounded-xl bg-emerald-600 px-4 py-3 text-lg font-semibold text-white hover:bg-emerald-500 disabled:opacity-50' }, ballot ? 'Update my vote' : 'Submit my vote');
      body.replaceChildren(h('form', { class: 'space-y-4', onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          await api(`${base}/vote`, { method: 'POST', body: { playerName: nameInput.value, preferences: ranking.getOrder() } });
          store.set(nameKey, nameInput.value.trim());
          ballot = { playerName: nameInput.value.trim(), preferences: ranking.getOrder().map(Number) };
          save.textContent = 'Update my vote';
          notice('ok', 'Your vote is saved.');
          keepVoteForm = true;
          render(await api(base));
        } catch (err) {
          notice('err', err.message);
        }
        save.disabled = false;
      } },
        h('label', { class: 'block text-sm font-medium text-slate-200' }, 'Your name', nameInput),
        h('p', { class: 'text-sm text-slate-400' }, 'Put the cube you most want to draft at the top.'),
        ranking.list, msg, save));
    }

    toggle.addEventListener('change', async () => {
      if (toggle.checked) { showForm(); return; }
      if (ballot && !confirm('Remove your vote? You will not be counted in the pods.')) { toggle.checked = true; return; }
      body.replaceChildren();
      if (ballot) {
        toggle.disabled = true;
        try {
          ballot = null;
          render(await api(`${base}/ballot`, { method: 'DELETE' }));
        } catch (err) {
          alert(err.message);
        }
        toggle.disabled = false;
      }
    });
    if (ballot) showForm();

    return card(
      h('h2', { class: 'font-semibold' }, 'Your vote'),
      h('label', { for: 'playing', class: 'flex items-center gap-3 text-sm text-slate-200' }, toggle, 'I am playing in this draft'),
      body);
  }

  // ---------- cubes and the cube editor ----------

  function cubesView(d) {
    const { session, cubes } = d;
    const dupes = duplicateNames(cubes);
    return card(
      h('div', { class: 'flex items-center justify-between gap-3' },
        h('h2', { class: 'font-semibold' }, `Cubes (${cubes.length})`),
        smallBtn('bg-slate-700 hover:bg-slate-600', 'Edit cubes', () => { editing = true; drawCubes(); })),
      cubes.map((c) => h('div', { class: 'flex items-start justify-between gap-3 rounded-lg bg-slate-900/50 p-3' },
        cubeInfo(c, dupes),
        h('div', { class: 'shrink-0 text-right text-xs text-slate-400' }, `${c.minPlayers}-${c.maxPlayers}`, h('br'), 'players'))));
  }

  function editorView(d) {
    const { session, cubes } = d;
    const list = h('div', { class: 'space-y-3' });
    const editor = createCubeEditor(list);
    cubes.forEach((c) => editor.add(c));
    const error = h('div', { class: 'hidden rounded-xl bg-red-900/40 p-3 text-sm text-red-200 ring-1 ring-red-700', role: 'alert' });
    const save = h('button', { class: 'rounded-xl bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50' }, 'Save cubes');
    const cancel = h('button', { type: 'button', class: 'rounded-xl bg-slate-700 px-4 py-2 font-semibold hover:bg-slate-600', onclick: () => { editing = false; drawCubes(); } }, 'Cancel');

    const notes = [
      'Removing a cube drops it from every ballot. New cubes are added at the bottom of every existing ballot, so ask players to revisit their votes.',
      session.status === 'assigned' && 'Saving a change clears the current pod assignment.',
      session.status !== 'open' && 'Voting is not open, so players cannot rerank until you reopen it.'
    ].filter(Boolean);

    return card(
      h('h2', { class: 'font-semibold' }, 'Edit cubes'),
      h('ul', { class: 'list-disc space-y-1 pl-5 text-xs text-amber-200' }, notes.map((n) => h('li', null, n))),
      h('form', { class: 'space-y-3', onsubmit: async (e) => {
        e.preventDefault();
        error.classList.add('hidden');
        save.disabled = true;
        save.textContent = 'Saving...';
        try {
          const next = await api(`${base}/cubes`, { method: 'PUT', body: { cubes: editor.serialize() } });
          editing = false;
          render(next);
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
          save.disabled = false;
          save.textContent = 'Save cubes';
        }
      } },
        list,
        h('button', { type: 'button', class: 'rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-600', onclick: () => editor.add() }, '+ Add another cube'),
        error,
        h('div', { class: 'flex gap-2' }, save, cancel)));
  }

  function drawCubes() {
    slots.cubes.replaceChildren(editing ? editorView(data) : cubesView(data));
  }

  // ---------- render ----------

  /** Redraws only the sections whose data changed, so a half-ranked ballot or half-edited cube list survives the 5 second refresh. */
  async function render(d) {
    data = d;
    const keep = keepVoteForm;
    keepVoteForm = false;
    const { session, cubes, voters, results } = d;
    const cubeKey = JSON.stringify(cubes);

    const topKey = JSON.stringify([session, d.voteCount, voters]);
    if (topKey !== keys.top) { keys.top = topKey; slots.top.replaceChildren(...topView(d)); }

    const voteKey = JSON.stringify([session.status, cubeKey, voters.some((v) => v.you)]);
    if (voteKey !== keys.vote) {
      keys.vote = voteKey;
      if (!keep) slots.vote.replaceChildren(await voteView(d));
    }

    if (!editing && (cubeKey !== keys.cubes || !slots.cubes.firstChild)) { keys.cubes = cubeKey; drawCubes(); }

    const resKey = JSON.stringify([results, cubeKey]);
    if (resKey !== keys.results) {
      keys.results = resKey;
      slots.results.replaceChildren(...(results ? [h('h2', { class: 'pt-2 text-xl font-bold' }, 'Results'), ...resultsView(results, duplicateNames(cubes)).flat(Infinity).filter(Boolean)] : []));
    }

    // Poll only while votes can still change.
    clearInterval(timer);
    if (session.status === 'open') timer = setInterval(refresh, 5000);
  }

  async function refresh() {
    if (document.hidden || busy) return;
    try { render(await api(base)); } catch { /* keep the last view; try again next tick */ }
  }

  app.replaceChildren(slots.top, h('div', { class: 'mt-4 space-y-4' }, slots.vote, slots.cubes, slots.results));
  api(base).then(render).catch((err) => showError(app, err.status === 404 ? 'This admin link is not valid.' : err.message));
})();
