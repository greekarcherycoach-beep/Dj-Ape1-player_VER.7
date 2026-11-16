'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAIN = 'library.json';
const PREV = 'library.prev.json';
const BK_RE = /^library-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/;
const KEEP_BACKUPS = 15;
const AUTO_BACKUP_MS = 12 * 3600 * 1000;

/** The renderer writes {"app":..,"v":3,"saved":..,"count":N,...} — count is always near the start. */
const parseCount = (head) => {
  const m = /"count"\s*:\s*(\d+)/.exec(String(head).slice(0, 400));
  return m ? Number(m[1]) : null;
};

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

class LibraryStore {
  constructor(dir) {
    this.dir = dir;
    this.bkDir = path.join(dir, 'backups');
    this.main = path.join(dir, MAIN);
    this.prev = path.join(dir, PREV);
    this.queue = Promise.resolve(); // serialises writes
  }

  _serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async _head(file) {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(400);
      const { bytesRead } = await fh.read(buf, 0, 400, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** Atomic save: write temp file, keep the previous version, then rename. */
  save(json) {
    return this._serial(async () => {
      if (typeof json !== 'string' || json.length < 2) throw new Error('empty library payload');
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = this.main + '.tmp';
      await fsp.writeFile(tmp, json, 'utf8');
      try {
        await fsp.rename(this.main, this.prev);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await fsp.rename(tmp, this.main);
      await this._autoBackup();
      return true;
    });
  }

  async _validRead(file) {
    const text = await fsp.readFile(file, 'utf8');
    const j = JSON.parse(text); // throws when truncated / corrupt
    if (!j || !Array.isArray(j.tracks)) throw new Error('not a library file');
    return text;
  }

  /** Returns {json} from the main file, {json, from} from prev / a backup, or null. */
  async load() {
    const tryFile = async (file) => {
      try { return await this._validRead(file); } catch { return null; }
    };
    const main = await tryFile(this.main);
    if (main !== null) {
      const c = parseCount(main);
      if (c === 0) return null; // intentionally emptied library
      return { json: main };
    }
    const prev = await tryFile(this.prev);
    if (prev !== null) return { json: prev, from: PREV };
    for (const b of await this.backups()) {
      const t = await tryFile(path.join(this.bkDir, b.name));
      if (t !== null) return { json: t, from: b.name };
    }
    return null;
  }

  async info() {
    try {
      const st = await fsp.stat(this.main);
      const count = parseCount(await this._head(this.main));
      return { exists: true, count: count == null ? 0 : count, size: st.size, mtime: st.mtimeMs };
    } catch {
      return { exists: false, count: 0, size: 0 };
    }
  }

  async backups() {
    let names = [];
    try { names = (await fsp.readdir(this.bkDir)).filter((n) => BK_RE.test(n)); } catch { return []; }
    const out = [];
    for (const name of names) {
      try {
        const file = path.join(this.bkDir, name);
        const st = await fsp.stat(file);
        out.push({ name, size: st.size, mtime: st.mtimeMs, count: parseCount(await this._head(file)) });
      } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  }

  backupNow() {
    return this._serial(async () => {
      try { await fsp.access(this.main); } catch { return null; }
      return this._makeBackup();
    });
  }

  async _makeBackup() {
    await fsp.mkdir(this.bkDir, { recursive: true });
    const name = `library-${stamp()}.json`;
    await fsp.copyFile(this.main, path.join(this.bkDir, name));
    const all = await this.backups();
    for (const old of all.slice(KEEP_BACKUPS)) await fsp.unlink(path.join(this.bkDir, old.name)).catch(() => {});
    return name;
  }

  async _autoBackup() {
    const list = await this.backups();
    if (!list.length || Date.now() - list[0].mtime > AUTO_BACKUP_MS) {
      const c = parseCount(await this._head(this.main));
      if (c) await this._makeBackup();
    }
  }

  async readBackup(name) {
    if (!BK_RE.test(String(name))) throw new Error('invalid backup name');
    return fsp.readFile(path.join(this.bkDir, name), 'utf8');
  }
}

module.exports = { LibraryStore, parseCount, BK_RE };
