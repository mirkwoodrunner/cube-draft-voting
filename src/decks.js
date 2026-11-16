'use strict';

/**
 * Decks, stored in the draft_decks table. One row per seat name in a draft:
 * the deck's name, a photo, and the player's notes for their deck report.
 * The browser shrinks a photo before sending it, so rows stay small.
 */

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const LIMITS = { deckName: 80, notes: 1500, matchNote: 600 };

/** The image type from the file's first bytes, or null if it is not a JPEG, PNG or WebP. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const photoUrl = (publicId, r) => `/api/drafts/${encodeURIComponent(publicId)}/decks/${r.id}/photo?v=${new Date(r.updated_at).getTime()}`;

/**
 * { name: { id, deckName, photoUrl, notes, matchNotes, postedAt } } for every deck row
 * in a draft. photoUrl is null when there is no photo.
 */
async function byName(db, draftRowId, publicId) {
  const { rows } = await db.query(
    `SELECT id, player_name, deck_name, notes, match_notes, posted_at, updated_at, photo_data IS NOT NULL AS has_photo
     FROM draft_decks WHERE draft_id = $1`,
    [draftRowId]
  );
  const out = {};
  for (const r of rows) {
    out[r.player_name] = {
      id: r.id,
      deckName: r.deck_name,
      photoUrl: r.has_photo ? photoUrl(publicId, r) : null,
      notes: r.notes,
      matchNotes: r.match_notes || {},
      postedAt: r.posted_at
    };
  }
  return out;
}

/** { name: { id, photoUrl } } for the decks in a draft that have a photo. */
async function photosByName(db, draftRowId, publicId) {
  const all = await byName(db, draftRowId, publicId);
  const out = {};
  for (const [name, d] of Object.entries(all)) if (d.photoUrl) out[name] = { id: d.id, photoUrl: d.photoUrl };
  return out;
}

/** Saves the photo for one seat, adding the deck row if needed. */
async function savePhoto(db, draftRowId, name, playerId, data, mime) {
  await db.query(
    `INSERT INTO draft_decks (draft_id, player_name, player_id, photo_data, photo_mime_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (draft_id, lower(player_name)) DO UPDATE SET
       player_name = EXCLUDED.player_name, player_id = COALESCE(EXCLUDED.player_id, draft_decks.player_id),
       photo_data = EXCLUDED.photo_data, photo_mime_type = EXCLUDED.photo_mime_type, updated_at = now()`,
    [draftRowId, name, playerId, data, mime]
  );
}

async function removePhoto(db, draftRowId, name) {
  await db.query(
    `UPDATE draft_decks SET photo_data = NULL, photo_mime_type = NULL, updated_at = now()
     WHERE draft_id = $1 AND lower(player_name) = lower($2)`,
    [draftRowId, name]
  );
}

/** Saves the deck name and notes for one seat, adding the deck row if needed. */
async function saveDetails(db, draftRowId, name, playerId, { deckName, notes, matchNotes }) {
  await db.query(
    `INSERT INTO draft_decks (draft_id, player_name, player_id, deck_name, notes, match_notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (draft_id, lower(player_name)) DO UPDATE SET
       player_name = EXCLUDED.player_name, player_id = COALESCE(EXCLUDED.player_id, draft_decks.player_id),
       deck_name = EXCLUDED.deck_name, notes = EXCLUDED.notes, match_notes = EXCLUDED.match_notes, updated_at = now()`,
    [draftRowId, name, playerId, deckName, notes, JSON.stringify(matchNotes)]
  );
}

/** Trims the text people type, keeping their line breaks. Empty becomes null. */
function cleanNote(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return null;
  if (s.length > max) throw new Error(`must be ${max} characters or fewer`);
  return s;
}

const isPlayed = (m) => m.w1 !== null && m.w1 !== undefined;

/**
 * The deck report a player posts to Discord, like:
 *
 *   Bant Broodscale went 2-1 in Pauper Cube
 *
 *   2-1 vs Will on Izzet
 *   Game three came down to the last turn.
 *
 *   This was a fun cube!
 *
 * `matches` are the draft's matches in the stored shape ({ round, p1, p2, w1, w2, d, id }).
 * `deckNames` maps each player to their deck's name, to say what the opponent played.
 */
function reportText({ name, cubeName, deck = {}, matches = [], deckNames = {} }) {
  const mine = matches.filter((m) => isPlayed(m) && (m.p1 === name || m.p2 === name)).sort((a, b) => a.round - b.round);
  const rows = mine.map((m) => {
    const first = m.p1 === name;
    const g = first ? [m.w1, m.w2] : [m.w2, m.w1];
    return { id: m.id, opp: first ? m.p2 : m.p1, won: g[0], lost: g[1], drawn: m.d || 0 };
  });
  const rec = { w: 0, l: 0, d: 0 };
  for (const r of rows) rec[r.won > r.lost ? 'w' : r.won < r.lost ? 'l' : 'd'] += 1;
  const record = `${rec.w}-${rec.l}${rec.d ? `-${rec.d}` : ''}`;
  const undefeated = rows.length === 3 && rec.w === 3;

  const deckName = deck.deckName || 'My deck';
  const where = cubeName ? ` in ${cubeName}` : '';
  const head = undefeated ? `${record} undefeated with ${deckName}${where}! 🏆` : `${deckName} went ${record}${where}`;
  const notes = deck.matchNotes || {};
  const anyNotes = rows.some((r) => notes[r.id]);
  const lines = rows.map((r) => {
    const oppDeck = deckNames[r.opp];
    const line = `${r.won}-${r.lost}${r.drawn ? `-${r.drawn}` : ''} vs ${r.opp}${oppDeck ? ` on ${oppDeck}` : ''}`;
    return notes[r.id] ? `${line}\n${notes[r.id]}` : line;
  });
  const parts = [head];
  if (lines.length) parts.push(anyNotes ? lines.join('\n\n') : lines.join('\n'));
  if (deck.notes) parts.push(deck.notes);
  return parts.join('\n\n');
}

/** Splits text into Discord-sized messages, at blank lines where it can. */
function splitMessage(text, max = 2000) {
  const out = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    let piece = para;
    while (piece.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    const next = cur ? `${cur}\n\n${piece}` : piece;
    if (next.length > max) { out.push(cur); cur = piece; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { MAX_PHOTO_BYTES, LIMITS, sniffImage, byName, photosByName, savePhoto, removePhoto, saveDetails, cleanNote, reportText, splitMessage };
