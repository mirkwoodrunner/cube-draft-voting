const cubesEl = document.getElementById('cubes');
const errorEl = document.getElementById('error');
const inputCls = 'w-full rounded-lg bg-slate-900 px-3 py-2 text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500';
const rows = [];

function field(label, input, extra = '') {
  return h('label', { class: `block text-xs font-medium text-slate-300 ${extra}` }, label, h('div', { class: 'mt-1 font-normal' }, input));
}

function addRow() {
  const url = h('input', { type: 'text', inputmode: 'url', autocapitalize: 'off', required: true, placeholder: 'https://cubecobra.com/cube/overview/...', class: inputCls });
  const fetchBtn = h('button', { type: 'button', class: 'shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50' }, 'Fetch details');
  const status = h('p', { class: 'text-xs text-slate-400' });
  const name = h('input', { maxlength: 200, class: inputCls });
  const author = h('input', { maxlength: 100, class: inputCls });
  const cards = h('input', { type: 'number', min: 0, class: inputCls });
  const tags = h('input', { placeholder: 'comma separated', class: inputCls });
  const min = h('input', { type: 'number', min: 1, max: 64, value: 6, required: true, class: inputCls });
  const max = h('input', { type: 'number', min: 1, max: 64, value: 8, required: true, class: inputCls });
  const details = h('div', { class: 'hidden grid grid-cols-2 gap-3' },
    field('Cube name', name, 'col-span-2'), field('Author', author), field('Card count', cards), field('Tags', tags, 'col-span-2'));
  const remove = h('button', { type: 'button', class: 'text-xs text-red-300 hover:underline', 'aria-label': 'Remove this cube' }, 'Remove');
  const title = h('div', { class: 'text-sm font-semibold text-slate-200' });

  const row = { url, name, author, cards, tags, min, max, fetched: null };
  const card = h('div', { class: 'space-y-3 rounded-2xl bg-slate-800 p-4 ring-1 ring-slate-700' },
    h('div', { class: 'flex items-center justify-between' }, title, remove),
    h('div', { class: 'flex gap-2' }, url, fetchBtn),
    status, details,
    h('div', { class: 'grid grid-cols-2 gap-3' }, field('Min players', min), field('Max players', max)));
  row.card = card;
  row.title = title;

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
      tags.value = (cube.tags || []).join(', ');
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
    card.remove();
    renumber();
  });

  rows.push(row);
  cubesEl.append(card);
  renumber();
  url.focus();
}

function renumber() {
  rows.forEach((r, i) => {
    r.title.textContent = `Cube ${i + 1}`;
    r.card.querySelector('button[aria-label="Remove this cube"]').classList.toggle('hidden', rows.length === 1);
  });
}

document.getElementById('add').addEventListener('click', addRow);
addRow();

document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.classList.add('hidden');
  const submit = document.getElementById('submit');
  submit.disabled = true;
  submit.textContent = 'Creating...';
  try {
    const body = {
      title: document.getElementById('title').value,
      cubes: rows.map((r) => ({
        url: r.url.value.trim(),
        minPlayers: Number(r.min.value),
        maxPlayers: Number(r.max.value),
        // Only send details when the admin has seen them. Otherwise the server looks them up.
        ...(r.name.value.trim() ? {
          name: r.name.value,
          author: r.author.value,
          cardCount: r.cards.value === '' ? null : Number(r.cards.value),
          tags: r.tags.value.split(',').map((t) => t.trim()).filter(Boolean)
        } : {})
      }))
    };
    const out = await api('/sessions', { method: 'POST', body });
    document.getElementById('form').classList.add('hidden');
    document.getElementById('links').replaceChildren(
      linkBox('Admin Dashboard Link', 'Keep this private. It controls the session.', out.adminUrl, 'amber'),
      linkBox('Player Voting Link', 'Share this with your players.', out.voteUrl, 'emerald'));
    document.getElementById('open-admin').href = out.adminUrl;
    document.getElementById('done').classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    submit.disabled = false;
    submit.textContent = 'Create session';
  }
});
