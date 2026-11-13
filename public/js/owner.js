(async function () {
  const app = document.getElementById('app');
  const card = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
  const STATUS = { open: ['Voting open', 'bg-emerald-600'], closed: ['Voting closed', 'bg-amber-600'], assigned: ['Pods assigned', 'bg-sky-600'] };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function loginView(enabled) {
    if (!enabled) {
      return card(
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, 'Owner login'),
        h('p', { class: 'text-sm text-slate-300' }, 'Owner login is turned off. Set the ADMIN_PASSWORD environment variable on the server and restart it.'));
    }
    const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', class: 'mt-1 w-full rounded-lg bg-slate-900 px-3 py-2 ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500' });
    const err = h('p', { class: 'hidden text-sm text-red-300', role: 'alert' });
    const go = h('button', { class: 'w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50' }, 'Log in');
    return card(
      h('h1', { class: 'text-2xl font-bold text-emerald-400' }, 'Owner login'),
      h('p', { class: 'text-sm text-slate-400' }, 'See every draft and its votes, open any admin dashboard, and manage the cube library.'),
      h('form', { class: 'space-y-3', onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        try {
          await api('/owner/login', { method: 'POST', body: { password: pw.value } });
          load();
        } catch (ex) {
          err.textContent = ex.message;
          err.classList.remove('hidden');
          go.disabled = false;
        }
      } },
        h('label', { class: 'block text-sm font-medium text-slate-200' }, 'Password', pw), err, go));
  }

  function sessionRow(s, refresh) {
    const [text, color] = STATUS[s.status] || STATUS.open;
    const facts = [
      new Date(s.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
      plural(s.votes, 'vote'),
      plural(s.cubes, 'cube'),
      s.pods ? plural(s.pods, 'pod') : null,
      s.matches ? plural(s.matches, 'match result') : null
    ].filter(Boolean);
    return h('div', { class: 'flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-900/50 p-3' },
      h('div', { class: 'min-w-0' },
        h('div', { class: 'flex flex-wrap items-center gap-2' },
          h('span', { class: 'font-semibold' }, s.title),
          h('span', { class: `rounded-full px-2 py-0.5 text-[11px] font-semibold text-white ${color}` }, text),
          s.teamMode && h('span', { class: 'rounded-full bg-violet-600 px-2 py-0.5 text-[11px] font-semibold text-white' }, 'Team draft')),
        h('div', { class: 'text-xs text-slate-400' }, facts.join(' · '))),
      s.adminUrl
        ? h('div', { class: 'flex shrink-0 gap-2' },
          h('a', { href: s.adminUrl, class: 'rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold hover:bg-emerald-500' }, 'Open'),
          h('button', { type: 'button', class: 'rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold hover:bg-red-600', onclick: async (e) => {
            if (!confirm(`Delete "${s.title}"? Its ballots, pods and match results are removed for good.`)) return;
            e.currentTarget.disabled = true;
            try { await api(`/admin/${s.adminUrl.split('/').pop()}`, { method: 'DELETE' }); } catch (ex) { alert(ex.message); }
            refresh();
          } }, 'Delete'))
        : h('span', { class: 'text-xs text-slate-500' }, 'Made with the first version, no dashboard'));
  }

  function libraryRow(c, refresh) {
    return h('div', { class: 'flex items-start justify-between gap-3 rounded-lg bg-slate-900/50 p-3' },
      cubeInfo(c, new Set()),
      h('div', { class: 'flex shrink-0 items-center gap-3' },
        h('span', { class: 'text-xs text-slate-400' }, `${c.minPlayers}-${c.maxPlayers} players`),
        h('button', { type: 'button', class: 'rounded-lg bg-slate-700 px-2.5 py-1.5 text-xs font-semibold hover:bg-red-600', onclick: async (e) => {
          if (!confirm(`Remove ${c.name} from the library? Drafts that already use it are not changed.`)) return;
          e.currentTarget.disabled = true;
          try { await api(`/library/${c.savedId}`, { method: 'DELETE' }); } catch (ex) { alert(ex.message); }
          refresh();
        } }, 'Remove')));
  }

  async function load() {
    let me;
    try { me = await api('/owner/me'); } catch (ex) { return showError(app, ex.message); }
    if (!me.loggedIn) return app.replaceChildren(loginView(me.enabled));

    const [{ sessions }, { cubes }] = await Promise.all([api('/owner/sessions'), api('/library')]);
    app.replaceChildren(
      h('div', { class: 'flex flex-wrap items-center justify-between gap-3' },
        h('h1', { class: 'text-2xl font-bold text-emerald-400' }, 'All drafts'),
        h('div', { class: 'flex gap-2' },
          h('a', { href: '/', class: 'rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold hover:bg-emerald-500' }, 'New draft'),
          h('button', { type: 'button', class: 'rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold hover:bg-slate-600', onclick: async () => {
            await api('/owner/logout', { method: 'POST' });
            load();
          } }, 'Log out'))),
      h('div', { class: 'mt-4 space-y-4' },
        card(
          h('h2', { class: 'font-semibold' }, `Drafts (${sessions.length})`),
          h('p', { class: 'text-xs text-slate-400' }, 'Open a draft to see its ballots, edit pods, or enter match results.'),
          sessions.length ? sessions.map((s) => sessionRow(s, load)) : h('p', { class: 'text-sm text-slate-400' }, 'No drafts yet.')),
        card(
          h('h2', { class: 'font-semibold' }, `Cube library (${cubes.length})`),
          h('p', { class: 'text-xs text-slate-400' }, 'Cubes saved here show up in "Add a saved cube" when you set up a draft. Tick "Save to my cube library" on a cube to add it.'),
          cubes.length ? cubes.map((c) => libraryRow(c, load)) : h('p', { class: 'text-sm text-slate-400' }, 'No saved cubes yet.'))));
  }

  load();
})();
