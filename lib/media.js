'use strict';
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { mimeFor } = require('./audio');

/**
 * Opens a file for the djfile:// protocol with HTTP Range support
 * (needed for seeking inside <audio> and for fast partial reads).
 * Returns { status, headers, stream|null }.
 */
async function openRange(file, rangeHeader) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const size = st.size;
  const headers = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
  if (size === 0) return { status: 200, headers: { ...headers, 'Content-Length': '0' }, stream: null };

  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
    }
    if (start > end || start >= size) {
      return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` }, stream: null };
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return { status, headers, stream: fs.createReadStream(file, { start, end }) };
}

/** djfile://local/<encodeURIComponent(absolute path)>  ->  absolute path */
function pathFromUrl(url) {
  const u = new URL(url);
  return decodeURIComponent(u.pathname.replace(/^\//, ''));
}

/** Builds a fetch Response (used by protocol.handle) */
async function respond(file, rangeHeader) {
  const r = await openRange(file, rangeHeader);
  return new Response(r.stream ? Readable.toWeb(r.stream) : null, { status: r.status, headers: r.headers });
}

module.exports = { openRange, pathFromUrl, respond };
