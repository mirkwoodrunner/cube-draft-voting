(async function () {
  const errorEl = document.getElementById('error');
  const library = await loadLibrary();
  const editor = createCubeEditor(document.getElementById('cubes'), { savedUrls: new Set(library.map((c) => c.url)) });
  const picker = libraryPicker(library, editor);
  if (picker) document.getElementById('library').append(picker);

  document.getElementById('add').addEventListener('click', () => editor.add());
  editor.add();

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    const submit = document.getElementById('submit');
    submit.disabled = true;
    submit.textContent = 'Creating...';
    try {
      const out = await api('/sessions', {
        method: 'POST',
        body: {
          title: document.getElementById('title').value,
          teamMode: document.getElementById('team-mode').checked,
          cubes: editor.serialize()
        }
      });
      document.getElementById('form').classList.add('hidden');
      document.getElementById('links').replaceChildren(
        linkBox('Admin Dashboard Link', 'Keep this private. It controls the session. You can vote from there too.', out.adminUrl, 'amber'),
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
})();
