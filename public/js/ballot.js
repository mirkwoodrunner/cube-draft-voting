/**
 * Drag-and-drop ranking list shared by the player page and the admin's own ballot.
 * `getOrder()` returns the cube ids from first choice to last.
 */
function rankList(cubes, order, { disabled = false } = {}) {
  const byId = new Map(cubes.map((c) => [String(c.id), c]));
  const dupes = duplicateNames(cubes);
  const list = h('ol', { class: 'space-y-2', 'aria-label': 'Cubes in order of preference' });

  function renumber() {
    [...list.children].forEach((li, i) => {
      li.querySelector('[data-rank]').textContent = i + 1;
      li.querySelector('[data-up]').disabled = disabled || i === 0;
      li.querySelector('[data-down]').disabled = disabled || i === list.children.length - 1;
    });
  }
  const arrow = (label, attr, glyph, delta) => h('button', {
    type: 'button', 'aria-label': label, [attr]: true, disabled,
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
        !disabled && h('div', { 'data-handle': true, title: 'Drag to reorder', 'aria-hidden': 'true', class: 'flex h-[4.5rem] w-10 items-center justify-center rounded-lg bg-slate-700 text-2xl leading-none text-slate-300 hover:bg-slate-600' }, '⠿'))));
  }
  if (!disabled) makeSortable(list, renumber);
  renumber();

  return { list, getOrder: () => [...list.children].map((li) => li.dataset.id), lock: () => { list.querySelectorAll('button').forEach((b) => { b.disabled = true; }); } };
}

/** Ids in a saved ballot's order, then any cubes the ballot does not mention. */
function orderFromBallot(cubes, preferences) {
  const ids = cubes.map((c) => String(c.id));
  const ranked = preferences.map(String).filter((id) => ids.includes(id));
  return [...ranked, ...ids.filter((id) => !ranked.includes(id))];
}
