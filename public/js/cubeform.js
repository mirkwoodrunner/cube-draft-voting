/**
 * Editable list of cubes, shared by the create page and the admin edit screen.
 * Each row takes a Cube Cobra URL, can fetch name / author / card count, and
 * has min / max players. Rows built from an existing cube keep its `id`.
 */
const cubeInputCls = 'w-full rounded-lg bg-slate-900 px-3 py-2 text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500';

function cubeField(label, input, extra = '') {
  return h('label', { class: `block text-xs font-medium text-slate-300 ${extra}` }, label, h('div', { class: 'mt-1 font-normal' }, input));
}

function createCubeEditor(container) {
  const rows = [];

  function renumber() {
    rows.forEach((r, i) => {
      r.title.textContent = `Cube ${i + 1}`;
      r.remove.classList.toggle('hidden', rows.length === 1);
    });
  }

  function add(initial = null) {
    const url = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', required: true, placeholder: 'https://cubecobra.com/cube/overview/...', class: cubeInputCls });
    const fetchBtn = h('button', { type: 'button', class: 'shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50' }, 'Fetch details');
    const status = h('p', { class: 'text-xs text-slate-400' });
    const name = h('input', { maxlength: 200, class: cubeInputCls });
    const author = h('input', { maxlength: 100, class: cubeInputCls });
    const cards = h('input', { type: 'number', min: 0, class: cubeInputCls });
    const min = h('input', { type: 'number', min: 1, max: 64, value: 6, required: true, class: cubeInputCls });
    const max = h('input', { type: 'number', min: 1, max: 64, value: 8, required: true, class: cubeInputCls });
    const details = h('div', { class: 'hidden grid grid-cols-2 gap-3' },
      cubeField('Cube name', name, 'col-span-2'), cubeField('Author', author), cubeField('Card count', cards));
    const remove = h('button', { type: 'button', class: 'text-xs text-red-300 hover:underline', 'aria-label': 'Remove this cube' }, 'Remove');
    const title = h('div', { class: 'text-sm font-semibold text-slate-200' });

    const row = { id: null, url, name, author, cards, min, max, fetched: null, title, remove };
    row.card = h('div', { class: 'space-y-3 rounded-2xl bg-slate-800 p-4 ring-1 ring-slate-700' },
      h('div', { class: 'flex items-center justify-between' }, title, remove),
      h('div', { class: 'flex gap-2' }, url, fetchBtn),
      status, details,
      h('div', { class: 'grid grid-cols-2 gap-3' }, cubeField('Min players', min), cubeField('Max players', max)));

    if (initial) {
      row.id = initial.id;
      url.value = initial.url || '';
      name.value = initial.name || '';
      author.value = initial.author || '';
      cards.value = initial.cardCount ?? '';
      min.value = initial.minPlayers;
      max.value = initial.maxPlayers;
      row.fetched = url.value.trim();
      details.classList.remove('hidden');
    }

    async function load() {
      const value = url.value.trim();
      if (!value || row.fetched === value) return;
      fetchBtn.disabled = true;
      status.className = 'text-xs text-slate-400';
      status.textContent = 'Looking up cube...';
      try {
        const { cube } = await api('/cubecobra/preview', { method: 'POST', body: { url: value } });
        name.value = cube.name || '';
        author.value = cube.author || '';
        cards.value = cube.cardCount ?? '';
        row.fetched = value;
        status.className = 'text-xs text-emerald-400';
        status.textContent = 'Found it. You can correct anything below.';
      } catch (err) {
        status.className = 'text-xs text-amber-300';
        status.textContent = `${err.message}. You can fill in the details yourself below.`;
      }
      details.classList.remove('hidden');
      fetchBtn.disabled = false;
    }
    fetchBtn.addEventListener('click', load);
    url.addEventListener('change', load);
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      row.card.remove();
      renumber();
    });

    rows.push(row);
    container.append(row.card);
    renumber();
    if (!initial) url.focus();
  }

  /** The cubes as the API expects them. Details are only sent once the admin has seen them. */
  function serialize() {
    return rows.map((r) => ({
      ...(r.id !== null ? { id: r.id } : {}),
      url: r.url.value.trim(),
      minPlayers: Number(r.min.value),
      maxPlayers: Number(r.max.value),
      ...(r.name.value.trim() ? {
        name: r.name.value,
        author: r.author.value,
        cardCount: r.cards.value === '' ? null : Number(r.cards.value)
      } : {})
    }));
  }

  return { add, serialize };
}
