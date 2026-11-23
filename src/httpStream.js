'use strict';

/**
 * Write an ITERABLE of Buffers to an http.ServerResponse, honouring Node's
 * backpressure signal and client disconnects.
 *
 * Do NOT use `chunks.length` here: the ZIP writer is a generator, so it has
 * no `length` and an early implementation silently produced empty archives.
 */
function writeStream(res, chunks) {
  return new Promise((resolve) => {
    const it = chunks[Symbol.iterator]();
    let finished = false;
    const finish = () => { if (!finished) { finished = true; resolve(); } };
    res.once('close', finish);

    const pump = () => {
      if (finished || res.destroyed || res.writableEnded) return finish();
      while (true) {
        const next = it.next();
        if (next.done) { res.end(); return finish(); }
        if (!res.write(next.value)) { res.once('drain', pump); return; }
      }
    };
    pump();
  });
}

module.exports = { writeStream };
