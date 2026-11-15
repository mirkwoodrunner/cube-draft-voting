(async function () {
  const app = document.getElementById('app');
  let cubes;
  try {
    ({ cubes } = await api('/library'));
  } catch (err) {
    return showError(app, err.message);
  }
  const dupes = duplicateNames(cubes);
  app.replaceChildren(
    h('h1', { class: 'text-2xl font-bold text-emerald-400' }, 'Cube library'),
    h('p', { class: 'mb-5 mt-1 text-sm text-slate-400' }, `${cubes.length} saved cube${cubes.length === 1 ? '' : 's'} that drafts can pick from.`),
    cubes.length
      ? h('div', { class: 'space-y-2 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' },
        cubes.map((c) => h('div', { class: 'flex items-start justify-between gap-3 rounded-lg bg-slate-900/50 p-3' },
          cubeInfo(c, dupes),
          h('span', { class: 'shrink-0 text-xs text-slate-400' }, `${c.minPlayers}-${c.maxPlayers} players`))))
      : h('p', { class: 'rounded-xl bg-slate-800 p-4 text-slate-300 ring-1 ring-slate-700' }, 'No saved cubes yet.'));
})();
