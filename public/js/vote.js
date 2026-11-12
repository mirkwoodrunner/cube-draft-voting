(async function () {
  const app = document.getElementById('app');
  const sessionId = location.pathname.split('/')[2];
  const store = storage();
  const key = `cube-vote:${sessionId}`;

  let data;
  try {
    data = await api(`/sessions/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    return showError(app, err.status === 404 ? 'This voting link is not valid.' : err.message);
  }
  const { session, cubes } = data;
  const byId = new Map(cubes.map((c) => [String(c.id), c]));
  const dupes = duplicateNames(cubes);
  const saved = store.get(key) || {};

  // A returning player gets their saved order back. A new player gets a random one.
  let order = shuffle(cubes.map((c) => String(c.id)));
  let name = '';
  let hasBallot = false;
  if (saved.token) {
    try {
      const { ballot } = await api(`/sessions/${encodeURIComponent(sessionId)}/ballot`, { headers: { 'X-Voter-Token': saved.token } });
      if (ballot) {
        order = ballot.preferences.map(String).filter((id) => byId.has(id));
        name = ballot.playerName;
        hasBallot = true;
      }
    } catch { /* fall back to a fresh ballot */ }
  }

  const closed = session.status !== 'open';
  const list = h('ol', { class: 'space-y-2', 'aria-label': 'Cubes in order of preference' });
  const nameInput = h('input', { id: 'name', required: true, maxlength: 40, value: name, disabled: closed, placeholder: 'Your name', autocomplete: 'name', class: 'mt-1 w-full rounded-lg bg-slate-900 px-3 py-2 ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500 disabled:opacity-60' });
  const msg = h('div', { class: 'hidden rounded-xl p-3 text-sm', role: 'status' });
  const saveBtn = h('button', { class: 'w-full rounded-xl bg-emerald-600 px-4 py-3 text-lg font-semibold text-white hover:bg-emerald-500 disabled:opacity-50', disabled: closed }, hasBallot ? 'Update my vote' : 'Submit my vote');

  function renumber() {
    [...list.children].forEach((li, i) => {
      li.querySelector('[data-rank]').textContent = i + 1;
      li.querySelector('[data-up]').disabled = i === 0;
      li.querySelector('[data-down]').disabled = i === list.children.length - 1;
    });
  }
  const arrow = (label, attr, glyph, delta) => h('button', {
    type: 'button', 'aria-label': label, [attr]: true, disabled: closed,
    class: 'flex h-8 w-9 items-center justify-center rounded bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-30',
    onclick: (e) => { moveItem(e.currentTarget.closest('li'), delta); renumber(); }
  }, glyph);

  for (const id of order) {
    const cube = byId.get(id);
    list.append(h('li', { dataset: { id }, class: 'flex items-center gap-3 rounded-xl bg-slate-800 p-3 ring-1 ring-slate-700' },
      h('span', { 'data-rank': true, class: 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-lg font-bold' }),
      h('div', { class: 'min-w-0 flex-1' }, cubeInfo(cube, dupes)),
      h('div', { class: 'flex shrink-0 items-center gap-2' },
        h('div', { class: 'flex flex-col gap-1' }, arrow('Move up', 'data-up', '▲', -1), arrow('Move down', 'data-down', '▼', 1)),
        !closed && h('div', { 'data-handle': true, title: 'Drag to reorder', 'aria-hidden': 'true', class: 'flex h-[4.5rem] w-10 items-center justify-center rounded-lg bg-slate-700 text-2xl leading-none text-slate-300 hover:bg-slate-600' }, '⠿'))));
  }
  if (!closed) makeSortable(list, renumber);
  renumber();

  function notice(kind, text) {
    msg.className = `rounded-xl p-3 text-sm ring-1 ${kind === 'ok' ? 'bg-emerald-900/40 text-emerald-200 ring-emerald-700' : 'bg-red-900/40 text-red-200 ring-red-700'}`;
    msg.textContent = text;
  }

  const form = h('form', { class: 'space-y-4', onsubmit: async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      const out = await api(`/sessions/${encodeURIComponent(sessionId)}/vote`, {
        method: 'POST',
        body: {
          playerName: nameInput.value,
          preferences: [...list.children].map((li) => li.dataset.id),
          voterToken: saved.token || undefined
        }
      });
      saved.token = out.voterToken;
      store.set(key, saved);
      hasBallot = true;
      saveBtn.textContent = 'Update my vote';
      notice('ok', out.updated
        ? 'Your vote was updated.'
        : 'Your vote is saved. Come back to this link any time before voting closes to change it. Use the same browser.');
    } catch (err) {
      notice('err', err.message);
      if (err.code === 'closed') {
        list.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        return;
      }
    }
    saveBtn.disabled = false;
  } },
    h('div', null,
      h('label', { for: 'name', class: 'block text-sm font-medium text-slate-200' }, 'Your name'),
      nameInput),
    h('div', null,
      h('h2', { class: 'text-lg font-semibold' }, 'Rank the cubes'),
      h('p', { class: 'text-sm text-slate-400' }, 'Put the cube you most want to draft at the top. Drag the handle, or use the arrows.')),
    list, msg, saveBtn);

  app.replaceChildren(
    h('h1', { class: 'text-2xl font-bold text-emerald-400' }, session.title),
    h('p', { class: 'mb-5 mt-1 text-slate-400' }, closed ? 'Voting is closed.' : hasBallot ? 'You have already voted. You can change your vote below until voting closes.' : 'Rank every cube from your favorite to your least favorite.'),
    closed ? h('div', { class: 'mb-4 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-amber-500/30' }, 'Voting has closed, so ballots can no longer be changed.') : '',
    form);
})();
