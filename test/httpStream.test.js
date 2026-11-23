'use strict';
/**
 * Streaming ZIP download: a generator must be fully written. This is the
 * regression test for an empty-archive bug caused by reading `chunks.length`
 * on a generator (which is undefined).
 */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { writeStream } = require('../src/httpStream');

function fakeRes(blockAtIndex = -1) {
  const res = new EventEmitter();
  res.writes = [];
  res.ended = false;
  res.destroyed = false;
  res.writableEnded = false;
  res.write = (c) => { res.writes.push(c); return res.writes.length !== blockAtIndex; };
  res.end = () => { res.ended = true; res.writableEnded = true; };
  return res;
}
function* gen(chunks) { for (const c of chunks) yield c; }

test('generator：所有块按顺序写入并 end（ZIP 不能是空包）', async () => {
  const res = fakeRes();
  await writeStream(res, gen([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]));
  assert.equal(res.writes.length, 3);
  assert.equal(Buffer.concat(res.writes).toString(), 'abc');
  assert.equal(res.ended, true);
});

test('backpressure：write 返回 false 时等待 drain 后继续', async () => {
  const res = fakeRes(2);
  const p = writeStream(res, gen(['1', '2', '3', '4']));
  await new Promise(r => setImmediate(r));
  assert.equal(res.writes.length, 2, 'drain 前不得继续写');
  res.emit('drain');
  await p;
  assert.equal(res.writes.join(''), '1234');
  assert.equal(res.ended, true);
});

test('client disconnect：连接关闭后安静结束，不抛错', async () => {
  const res = fakeRes(1);
  const p = writeStream(res, gen(['1', '2', '3']));
  await new Promise(r => setImmediate(r));
  res.destroyed = true;
  res.emit('close');
  await p;   // must resolve, not hang
  assert.equal(res.ended, false);
});

test('空 iterable：直接结束响应', async () => {
  const res = fakeRes();
  await writeStream(res, gen([]));
  assert.equal(res.writes.length, 0);
  assert.equal(res.ended, true);
});
