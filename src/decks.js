'use strict';

/**
 * Deck photos, stored in the draft_decks table. One row per seat name in a draft.
 * The browser shrinks a photo before sending it, so rows stay small.
 */

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** The image type from the file's first bytes, or null if it is not a JPEG, PNG or WebP. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** { name: { id, photoUrl } } for every deck in a draft that has a photo. */
async function photosByName(db, draftRowId, publicId) {
  const { rows } = await db.query(
    'SELECT id, player_name, updated_at FROM draft_decks WHERE draft_id = $1 AND photo_data IS NOT NULL',
    [draftRowId]
  );
  const out = {};
  for (const r of rows) {
    out[r.player_name] = {
      id: r.id,
      photoUrl: `/api/drafts/${encodeURIComponent(publicId)}/decks/${r.id}/photo?v=${new Date(r.updated_at).getTime()}`
    };
  }
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

module.exports = { MAX_PHOTO_BYTES, sniffImage, photosByName, savePhoto, removePhoto };
