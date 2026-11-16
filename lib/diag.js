'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;

/** Appends one JSON object per line to diagnostics.log (rotated at 2 MB). */
class Diag {
  constructor(dir, memFn) {
    this.dir = dir;
    this.file = path.join(dir, 'diagnostics.log');
    this.memFn = memFn || (() => '');
  }

  write(kind, extra) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1');
      } catch { /* no log yet */ }
      const line = { t: new Date().toISOString(), kind, ...(extra && typeof extra === 'object' ? extra : {}), mem: this.memFn() };
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    } catch { /* logging must never throw */ }
  }
}

module.exports = { Diag };
