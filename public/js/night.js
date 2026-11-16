/**
 * Draft night section of the player page, shown once pods are assigned: the
 * player's own pod, reporting a match, their deck photo, every pod's standings
 * and photos, and a button to share the results.
 * `voterToken` is the ballot edit token this browser holds, or null.
 */
function draftNight(draftId, voterToken) {
  const root = h('div', { class: 'space-y-4' }, h('p', { class: 'text-slate-400' }, 'Loading results...'));
  const base = `/drafts/${encodeURIComponent(draftId)}`;
  const headers = voterToken ? { 'X-Voter-Token': voterToken } : {};
  const card = (...kids) => h('section', { class: 'space-y-3 rounded-2xl bg-slate-800 p-5 ring-1 ring-slate-700' }, ...kids);
  const btnCls = 'rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50';
  const TEAMS = ['Team A', 'Team B'];
  const played = (m) => m.player1Wins !== null && m.player1Wins !== undefined;
  let last = '';
  let busy = false;

  async function load(force = false) {
    if (busy && !force) return;
    try {
      const st = await api(`${base}/standings`, { headers });
      const key = JSON.stringify(st);
      if (key === last && !force) return;
      last = key;
      if (busy && !force) return; // the player started typing while this loaded
      busy = false;
      root.replaceChildren(...view(st).filter(Boolean));
    } catch (err) {
      if (!last) showError(root, err.message);
    }
  }

  const numberInput = (label, value = '') => h('input', {
    type: 'number', min: 0, max: 9, inputmode: 'numeric', value, 'aria-label': label,
    class: 'w-16 rounded-lg bg-slate-900 px-2 py-2 text-center ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500'
  });

  function reportForm(st, pod, me) {
    const mine = pod.players.find((p) => p.name === me.name);
    const opponents = pod.players.filter((p) => p.name !== me.name && (!st.draft.teamMode || mine.team === null || p.team !== mine.team));
    const myMatches = pod.matches.filter((m) => m.player1 === me.name || m.player2 === me.name);
    const nextPairing = myMatches.filter((m) => !played(m)).sort((a, b) => a.roundNumber - b.roundNumber)[0];
    const lastRound = myMatches.reduce((mx, m) => Math.max(mx, m.roundNumber), 0);

    const round = h('input', { type: 'number', min: 1, max: 20, value: nextPairing ? nextPairing.roundNumber : lastRound + 1, 'aria-label': 'Round', class: 'w-16 rounded-lg bg-slate-900 px-2 py-2 text-center ring-1 ring-slate-600' });
    const opp = h('select', { 'aria-label': 'Opponent', class: 'min-w-0 flex-1 rounded-lg bg-slate-900 px-2 py-2 ring-1 ring-slate-600' },
      h('option', { value: '' }, 'Opponent'), opponents.map((p) => h('option', { value: p.name }, p.name)));
    if (nextPairing) opp.value = nextPairing.player1 === me.name ? nextPairing.player2 : nextPairing.player1;
    const wins = numberInput('Games you won');
    const losses = numberInput('Games you lost');
    const draws = numberInput('Drawn games', '0');
    const msg = h('p', { class: 'hidden text-sm', role: 'status' });
    const send = h('button', { type: 'submit', class: `${btnCls} bg-emerald-600 hover:bg-emerald-500` }, 'Report result');
    const form = h('form', { class: 'space-y-3 rounded-xl bg-slate-900/50 p-3', onsubmit: async (e) => {
      e.preventDefault();
      if (!opp.value) { alert('Pick your opponent'); return; }
      send.disabled = true;
      try {
        await api(`${base}/matches`, { method: 'POST', headers, body: { round: Number(round.value), opponent: opp.value, wins: wins.value, losses: losses.value, draws: draws.value || 0 } });
        await load(true);
      } catch (err) {
        msg.className = 'text-sm text-red-300';
        msg.textContent = err.message;
        send.disabled = false;
      }
    } },
      h('h3', { class: 'text-sm font-semibold text-slate-200' }, 'Report a match'),
      h('div', { class: 'flex flex-wrap items-center gap-2 text-sm' }, h('label', { class: 'flex items-center gap-1 text-slate-400' }, 'Round', round), opp),
      h('div', { class: 'flex flex-wrap items-center gap-3 text-sm text-slate-400' },
        h('label', { class: 'flex items-center gap-1' }, 'You won', wins),
        h('label', { class: 'flex items-center gap-1' }, 'They won', losses),
        h('label', { class: 'flex items-center gap-1' }, 'Draws', draws)),
      h('div', { class: 'flex items-center justify-between gap-2' },
        h('p', { class: 'text-xs text-slate-500' }, 'Count games. A 2-1 win is 2 and 1. Only the host can change a result once it is in.'),
        send),
      msg);
    // Don't redraw over a half-filled form.
    form.addEventListener('input', () => { busy = true; });
    return form;
  }

  // What the player has typed into the deck report and not saved yet, so a redraw keeps it.
  let deckDraft = null;
  const gather = (st) => deckDraft || {
    deckName: st.me.deck.deckName || '',
    notes: st.me.deck.notes || '',
    matchNotes: { ...st.me.deck.matchNotes }
  };

  async function saveDeck() {
    if (!deckDraft) return;
    await api(`${base}/decks/mine`, { method: 'PUT', headers, body: deckDraft });
    deckDraft = null;
  }

  /** Runs a deck report action: saves what was typed first, then redraws. */
  const deckAction = (fn) => async (e) => {
    const btn = e.currentTarget;
    const which = btn.dataset.act;
    btn.disabled = true;
    try {
      await saveDeck();
      const label = await fn(btn);
      await load(true);
      if (label) { // the button was redrawn, so say it on the new one
        const fresh = root.querySelector(`button[data-act="${which}"]`);
        if (fresh) {
          const old = fresh.textContent;
          fresh.textContent = label;
          setTimeout(() => { fresh.textContent = old; }, 2500);
        }
      }
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  };

  /** Shares the report through the phone's share menu (with the photo), or copies the text. */
  async function shareReport() {
    const { text, photoUrl } = await api(`${base}/decks/mine/report`, { headers });
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      let files = [];
      if (photoUrl) {
        const blob = await fetch(photoUrl).then((r) => r.blob());
        const file = new File([blob], 'deck.jpg', { type: blob.type || 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) files = [file];
      }
      try {
        await navigator.share(files.length ? { text, files } : { text });
        return null;
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
      }
    }
    await copyText(text);
    return photoUrl ? 'Copied! Add the photo in Discord' : 'Copied!';
  }

  function deckBlock(st, pod) {
    const me = st.me;
    const mine = pod.players.find((p) => p.name === me.name);
    const draft = gather(st);
    const keep = () => { busy = true; deckDraft = draft; };
    const area = (value, label, rows, max, onInput) => {
      const el = h('textarea', { rows, maxlength: max, 'aria-label': label, placeholder: label, class: 'w-full rounded-lg bg-slate-900 px-3 py-2 text-sm ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500' });
      el.value = value;
      el.addEventListener('input', () => { onInput(el.value); keep(); });
      return el;
    };
    const deckName = h('input', { maxlength: 80, value: draft.deckName, placeholder: 'Deck name, like Bant Broodscale', 'aria-label': 'Deck name', class: 'w-full rounded-lg bg-slate-900 px-3 py-2 ring-1 ring-slate-600 focus:outline-none focus:ring-emerald-500' });
    deckName.addEventListener('input', () => { draft.deckName = deckName.value; keep(); });

    const upload = photoPicker(mine.photoUrl ? 'Replace photo' : 'Add a deck photo', async (file) => {
      await uploadPhoto(`${base}/decks/mine/photo`, file, headers);
      await load(true);
    }, `${btnCls} bg-sky-600 hover:bg-sky-500`);
    const remove = mine.photoUrl && h('button', { type: 'button', class: `${btnCls} bg-slate-700 hover:bg-red-600`, onclick: async (e) => {
      if (!(await confirmDialog('Remove your deck photo?', { confirmLabel: 'Remove' }))) return;
      e.currentTarget.disabled = true;
      try {
        await api(`${base}/decks/mine/photo`, { method: 'DELETE', headers });
        await load(true);
      } catch (err) { alert(err.message); }
    } }, 'Remove');

    const myMatches = pod.matches.filter((m) => played(m) && (m.player1 === me.name || m.player2 === me.name)).sort((a, b) => a.roundNumber - b.roundNumber);
    const deckOf = new Map(pod.players.map((p) => [p.name, p.deckName]));
    const matchNotes = myMatches.map((m) => {
      const first = m.player1 === me.name;
      const opp = first ? m.player2 : m.player1;
      const score = first ? `${m.player1Wins}-${m.player2Wins}` : `${m.player2Wins}-${m.player1Wins}`;
      const label = `${score}${m.draws ? `-${m.draws}` : ''} vs ${opp}${deckOf.get(opp) ? ` on ${deckOf.get(opp)}` : ''}`;
      return h('div', { class: 'space-y-1' },
        h('div', { class: 'text-sm font-medium text-slate-200' }, `Round ${m.roundNumber}: ${label}`),
        area(draft.matchNotes[m.id] || '', 'How did it go? (optional)', 2, 600, (v) => { draft.matchNotes[m.id] = v; }));
    });

    const save = h('button', { type: 'button', class: `${btnCls} bg-emerald-600 hover:bg-emerald-500`, dataset: { act: 'save' }, onclick: deckAction(async () => 'Saved') }, 'Save');
    const share = h('button', { type: 'button', class: `${btnCls} bg-indigo-600 hover:bg-indigo-500`, dataset: { act: 'share' }, onclick: deckAction(shareReport) }, 'Share my deck');
    const post = st.discordPost && h('button', { type: 'button', class: `${btnCls} bg-indigo-600 hover:bg-indigo-500`, dataset: { act: 'post' }, onclick: deckAction(async () => {
      await api(`${base}/decks/mine/post`, { method: 'POST', headers });
      return 'Posted!';
    }) }, me.deck.postedAt ? 'Post to Discord again' : 'Post to Discord');

    return h('div', { class: 'space-y-3 rounded-xl bg-slate-900/50 p-3' },
      h('h3', { class: 'text-sm font-semibold text-slate-200' }, 'Your deck'),
      deckName,
      h('div', { class: 'flex flex-wrap items-center gap-3' },
        mine.photoUrl ? photoThumb(mine.photoUrl, 'Your deck', 'h-20 w-20') : h('div', { class: 'flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-slate-600 text-xs text-slate-500' }, 'No photo'),
        h('div', { class: 'flex flex-wrap gap-2' }, upload, remove)),
      myMatches.length > 0 && h('div', { class: 'space-y-2' }, matchNotes),
      area(draft.notes, 'Anything else about the draft? (optional)', 3, 1500, (v) => { draft.notes = v; }),
      h('div', { class: 'flex flex-wrap items-center justify-end gap-2' }, save, share, post),
      h('p', { class: 'text-xs text-slate-500' }, st.discordPost
        ? 'Post to Discord puts your record, notes and photo in the group\'s channel. Share my deck opens your phone\'s share menu or copies the text.'
        : 'Share my deck opens your phone\'s share menu with the text and photo, so you can pick Discord. On a computer it copies the text.'));
  }

  function standingsTable(st, pod) {
    const th = (t, cls = '') => h('th', { class: `px-1.5 py-1 font-medium ${cls}` }, t);
    const td = (t, cls = '') => h('td', { class: `px-1.5 py-1.5 ${cls}` }, t);
    return h('div', { class: 'overflow-x-auto' },
      h('table', { class: 'w-full text-left text-sm' },
        h('thead', { class: 'text-xs text-slate-400' }, h('tr', null, th('#'), th('Player'), st.draft.teamMode && th('Team'), th('W-L-D', 'text-right'), th('Pts', 'text-right'), th('Games', 'text-right'))),
        h('tbody', { class: 'divide-y divide-slate-700' },
          pod.players.map((p) => h('tr', { class: st.me && st.me.name === p.name ? 'bg-emerald-900/20' : '' },
            td(pod.matchesPlayed ? p.rank : '', 'text-slate-400'),
            td(h('span', { class: 'flex items-center gap-2' }, p.photoUrl && photoThumb(p.photoUrl, `${p.name}'s deck`, 'h-8 w-8'),
              h('span', { class: 'min-w-0' }, h('span', null, p.name), p.trophy && h('span', { title: '3-0' }, ' 🏆'), p.deckName && h('span', { class: 'block text-xs text-slate-400' }, p.deckName)))),
            st.draft.teamMode && td(p.team === null ? '' : TEAMS[p.team], 'text-xs text-slate-400'),
            td(`${p.wins}-${p.losses}-${p.draws}`, 'text-right'),
            td(p.matchPoints, 'text-right font-semibold'),
            td(p.gwp === null ? '' : `${Math.round(p.gwp * 100)}%`, 'text-right text-slate-400'))))));
  }

  function matchList(pod) {
    const list = [...pod.matches].sort((a, b) => a.roundNumber - b.roundNumber);
    if (!list.length) return null;
    return h('details', { class: 'rounded-xl bg-slate-900/40 p-3' },
      h('summary', { class: 'cursor-pointer text-sm font-medium text-slate-200' }, `Matches (${list.filter(played).length} of ${list.length} reported)`),
      h('ul', { class: 'mt-2 space-y-1 text-sm' }, list.map((m) => h('li', { class: 'flex justify-between gap-2' },
        h('span', { class: 'text-slate-400' }, `R${m.roundNumber}`),
        h('span', { class: 'min-w-0 flex-1 truncate' }, `${m.player1} vs ${m.player2}`),
        h('span', { class: played(m) ? 'font-semibold' : 'text-slate-500' }, played(m) ? `${m.player1Wins}-${m.player2Wins}${m.draws ? `-${m.draws}` : ''}` : 'not played')))));
  }

  function podCard(st, pod) {
    const isMine = st.me && st.me.cubeId === pod.cubeId;
    return card(
      h('div', { class: 'flex flex-wrap items-baseline justify-between gap-2' },
        h('h3', { class: 'text-lg font-semibold' }, pod.cubeName, isMine && h('span', { class: 'ml-2 rounded-full bg-emerald-600/30 px-2 py-0.5 text-xs text-emerald-200' }, 'your pod')),
        pod.teamScore && h('div', { class: 'text-sm font-semibold' },
          h('span', { class: 'text-sky-300' }, `${TEAMS[0]} ${pod.teamScore[0]}`), h('span', { class: 'px-1.5 text-slate-500' }, '-'), h('span', { class: 'text-rose-300' }, `${pod.teamScore[1]} ${TEAMS[1]}`))),
      isMine && reportForm(st, pod, st.me),
      isMine && deckBlock(st, pod),
      standingsTable(st, pod),
      matchList(pod));
  }

  function view(st) {
    if (!st.pods.length) return [card(h('p', { class: 'text-slate-400' }, 'No pods yet.'))];
    const share = h('button', { type: 'button', class: `${btnCls} bg-indigo-600 hover:bg-indigo-500`, onclick: (e) => shareResults(draftId, e.currentTarget).catch((err) => alert(err.message)) }, 'Share results');
    const mine = st.me && st.pods.find((p) => p.cubeId === st.me.cubeId);
    const others = st.pods.filter((p) => p !== mine);
    return [
      h('div', { class: 'flex flex-wrap items-center justify-between gap-3' },
        h('h2', { class: 'text-xl font-bold' }, 'Draft night'), share),
      st.trophies.length > 0 && h('div', { class: 'rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200 ring-1 ring-amber-500/30' }, `🏆 3-0: ${st.trophies.map((t) => `${t.name} (${t.cubeName})`).join(', ')}`),
      st.me
        ? h('p', { class: 'text-sm text-slate-400' }, `You're playing as ${st.me.name}. Report your matches, then name your deck, add a photo and share how it went.`)
        : h('p', { class: 'text-sm text-slate-400' }, 'To report matches and add a deck photo, log in with Discord or open this link in the browser you voted from.'),
      mine && podCard(st, mine),
      ...others.map((p) => podCard(st, p))
    ];
  }

  load(true);
  setInterval(() => { if (!document.hidden) load(); }, 30000);
  return root;
}
