'use strict';
let mmPromise = null;
const loadMM = () => (mmPromise ||= import('music-metadata'));

const MAX_PICTURE = 4 * 1024 * 1024;

const commentText = (c) => {
  const first = Array.isArray(c) ? c[0] : c;
  if (!first) return '';
  return typeof first === 'string' ? first : String(first.text || '');
};

/**
 * Reads tags with music-metadata and returns the shape the renderer expects
 * (same field names as jsmediatags: title, artist, album, year, track, genre,
 * comment, picture{data,format}, TBPM{data}, TKEY{data}) plus __dur/__sr/__bits.
 */
async function readTags(file) {
  try {
    const { parseFile } = await loadMM();
    const m = await parseFile(file, { duration: false, skipPostHeaders: true });
    const c = m.common || {};
    const f = m.format || {};
    const pic = c.picture && c.picture[0];
    const out = {
      title: c.title || '',
      artist: c.artist || '',
      album: c.album || '',
      year: c.year ? String(c.year) : '',
      track: c.track && c.track.no ? String(c.track.no) : '',
      genre: (c.genre || []).join(';'),
      comment: commentText(c.comment),
      __dur: f.duration || 0,
      __sr: f.sampleRate || 0,
      __bits: f.bitsPerSample || 0,
    };
    if (pic && pic.data && pic.data.length <= MAX_PICTURE) {
      out.picture = { data: new Uint8Array(pic.data), format: pic.format || 'image/jpeg' };
    }
    if (c.bpm) out.TBPM = { data: String(c.bpm) };
    if (c.key) out.TKEY = { data: String(c.key) };
    return out;
  } catch {
    return {};
  }
}

module.exports = { readTags };
