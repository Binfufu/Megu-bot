import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { allowedFeedUrl, isPublicFeedAddress, retryAfterAt, fetchFeedSource } from '../src/feed-fetch.js';
const source = { url: 'https://openrouter.ai/api/v1/models' };
function fakeRequest({ status = 200, headers = {}, body = '{}', hang = false, fail = false, aborted = false } = {}) {
  let seen;
  const request = (url, options, callback) => {
    seen = { url, options };
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (fail) { req.emit('error', new Error('offline')); return; }
      if (hang) return;
      const res = Readable.from([Buffer.from(body)]);
      res.statusCode = status; res.headers = headers;
      callback(res);
      if (aborted) res.emit('aborted');
    });
    return req;
  };
  return { request, seen: () => seen };
}
test('exact approved HTTPS destinations only', () => {
  assert.equal(allowedFeedUrl(source.url).hostname, 'openrouter.ai');
  for (const url of ['http://openrouter.ai/', 'https://evil.test/', 'https://openrouter.ai.evil.test/', 'https://u:p@openrouter.ai/', 'https://openrouter.ai:444/']) assert.throws(() => allowedFeedUrl(url));
});
test('DNS denies private, metadata and mapped addresses', () => {
  for (const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','100.100.100.200','::1','::ffff:127.0.0.1','fc00::1','fe80::1','not-an-ip']) assert.equal(isPublicFeedAddress(ip), false, ip);
  for (const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicFeedAddress(ip), true, ip);
});
test('conditional GET preserves validators; 304 is not a body parse', async () => {
  const fake = fakeRequest({ status:304, headers:{etag:'"a"'} });
  const result = await fetchFeedSource(source,{etag:'"a"',lastModified:'Mon, 02 Nov 2026 00:00:00 GMT'},{request:fake.request});
  assert.equal(result.status,304); assert.equal(fake.seen().options.headers['if-none-match'],'"a"');
  assert.equal(result.etag,'"a"');
});
test('200 body and validators returned for atomic consumer commit', async () => {
  const result = await fetchFeedSource(source,{}, {request:fakeRequest({body:'{"data":[]}',headers:{etag:'"b"'}}).request});
  assert.equal(result.text,'{"data":[]}'); assert.equal(result.etag,'"b"');
});
test('stream byte ceiling works without content-length', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {maxBytes:2,request:fakeRequest({body:'long'}).request}), /too_large/);
});
test('declared byte ceiling rejects early', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {maxBytes:2,request:fakeRequest({headers:{'content-length':'100'}}).request}), /too_large/);
});
test('429 keeps server backoff; malformed responses are errors', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {now:1000,request:fakeRequest({status:429,headers:{'retry-after':'120'}}).request}), e => e.status===429 && e.retryAt===121000);
  await assert.rejects(fetchFeedSource(source,{}, {request:fakeRequest({status:500}).request}), /http_500/);
});
test('redirect may not escape allowlist', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {request:fakeRequest({status:302,headers:{location:'https://127.0.0.1/'}}).request}), /not_allowed/);
});
test('redirect loop is bounded', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {request:fakeRequest({status:302,headers:{location:source.url}}).request}), /redirect_invalid/);
});
test('network timeout terminates hung request', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {timeoutMs:10,request:fakeRequest({hang:true}).request}), /timeout/);
});
test('network and partial body failure never become successful empty input', async () => {
  await assert.rejects(fetchFeedSource(source,{}, {request:fakeRequest({fail:true}).request}), /offline/);
  await assert.rejects(fetchFeedSource(source,{}, {request:fakeRequest({aborted:true}).request}), /aborted/);
});
test('Retry-After supports seconds and HTTP-date', () => {
  assert.equal(retryAfterAt('60',0),60000);
  assert.equal(retryAfterAt('Mon, 02 Nov 2026 00:00:00 GMT',0),Date.UTC(2026,10,2));
  assert.equal(retryAfterAt('bad',0),null);
});
