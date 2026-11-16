'use strict';
const fs = require('fs');
const { isAudio } = require('./audio');

/** Watches music folders (recursive on Windows) and reports a debounced "something changed". */
class Watcher {
  constructor(onChange, delay = 5000) {
    this.onChange = onChange;
    this.delay = delay;
    this.list = [];
    this.timer = null;
  }

  set(paths) {
    this.close();
    for (const p of (paths || []).slice(0, 50)) {
      try {
        const w = fs.watch(p, { recursive: true, persistent: false }, (_ev, name) => {
          const n = name ? String(name) : '';
          if (n && /\.[a-z0-9]{1,5}$/i.test(n) && !isAudio(n)) return; // ignore covers, logs, …
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.onChange(), this.delay);
        });
        w.on('error', () => {});
        this.list.push(w);
      } catch { /* folder missing / unsupported */ }
    }
  }

  close() {
    clearTimeout(this.timer);
    for (const w of this.list) { try { w.close(); } catch { /* ignore */ } }
    this.list = [];
  }
}

module.exports = { Watcher };
