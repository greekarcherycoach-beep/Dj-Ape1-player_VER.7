'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LibraryStore, parseCount } = require('../lib/store');
const { openRange, pathFromUrl } = require('../lib/media');
const { isAudio } = require('../lib/audio');
const { readTags } = require('../lib/tags');
const { Diag } = require('../lib/diag');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ml-'));
const lib = (n) => JSON.stringify({ app: 'music_library', v: 3, saved: 'x', count: n, playlists: [], dirs: [], tracks: Array.from({ length: n }, (_, i) => ({ id: 't' + i })), covers: [] });

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

test('parseCount reads the count from the file head', () => {
  assert.equal(parseCount(lib(123)), 123);
  assert.equal(parseCount('{}'), null);
});

test('store: save / load / info / prev fallback', async () => {
  const s = new LibraryStore(path.join(tmp(), 'library'));
  assert.equal(await s.load(), null);
  await s.save(lib(5));
  assert.deepEqual(await s.info(), { ...(await s.info()), exists: true, count: 5 });
  assert.equal(JSON.parse((await s.load()).json).tracks.length, 5);
  await s.save(lib(7));
  fs.writeFileSync(s.main, '{"app":"x","tracks":[{"id'); // truncated main file
  const r = await s.load();
  assert.equal(r.from, 'library.prev.json');
  assert.equal(JSON.parse(r.json).tracks.length, 5);
});

test('store: an intentionally emptied library stays empty', async () => {
  const s = new LibraryStore(path.join(tmp(), 'library'));
  await s.save(lib(3));
  await s.save(lib(0));
  assert.equal(await s.load(), null);
});

test('store: backups are created, listed, read and validated', async () => {
  const s = new LibraryStore(path.join(tmp(), 'library'));
  await s.save(lib(4));
  const list = await s.backups(); // auto backup after first save
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 4);
  assert.equal(JSON.parse(await s.readBackup(list[0].name)).tracks.length, 4);
  await assert.rejects(() => s.readBackup('../library.json'));
  const name = await s.backupNow();
  assert.match(name, /^library-/);
});

test('media: range requests', async () => {
  const f = path.join(tmp(), 'a.mp3');
  fs.writeFileSync(f, Buffer.from('0123456789'));
  let r = await openRange(f, null);
  assert.equal(r.status, 200);
  assert.equal((await readAll(r.stream)).toString(), '0123456789');
  r = await openRange(f, 'bytes=2-4');
  assert.equal(r.status, 206);
  assert.equal(r.headers['Content-Range'], 'bytes 2-4/10');
  assert.equal((await readAll(r.stream)).toString(), '234');
  r = await openRange(f, 'bytes=7-');
  assert.equal((await readAll(r.stream)).toString(), '789');
  r = await openRange(f, 'bytes=-3');
  assert.equal((await readAll(r.stream)).toString(), '789');
  r = await openRange(f, 'bytes=50-60');
  assert.equal(r.status, 416);
});

test('media: djfile url round trip (windows + unix paths, special chars)', () => {
  for (const p of ['C:\\Music\\Ελληνικά #1 & more\\a b.mp3', '\\\\server\\share\\x.flac', '/home/u/μουσική/a?b.mp3']) {
    assert.equal(pathFromUrl('djfile://local/' + encodeURIComponent(p)), p);
  }
});

test('audio: extension filter', () => {
  assert.ok(isAudio('x.MP3') && isAudio('a.flac') && !isAudio('cover.jpg') && !isAudio('notes.txt'));
});

test('tags: reads duration from a wav and survives bad files', async () => {
  const sr = 8000;
  const data = Buffer.alloc(sr * 2); // 1 s of silence, 16-bit mono
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  const f = path.join(tmp(), 'a.wav');
  fs.writeFileSync(f, Buffer.concat([h, data]));
  const t = await readTags(f);
  assert.ok(Math.abs(t.__dur - 1) < 0.05, 'duration ' + t.__dur);
  assert.equal(t.__sr, sr);
  assert.deepEqual(await readTags(path.join(tmp(), 'missing.mp3')), {});
});

test('diag: writes JSON lines in the same format as the sample log', () => {
  const d = new Diag(path.join(tmp(), 'logs'), () => 'Browser:1MB Tab:2MB');
  d.write('log-created');
  d.write('ui-lag', { ms: 3000, tracks: 10 });
  const lines = fs.readFileSync(d.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].kind, 'ui-lag');
  assert.equal(lines[1].mem, 'Browser:1MB Tab:2MB');
});
