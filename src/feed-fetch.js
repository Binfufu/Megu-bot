/** Independent fixed-source fetcher. No bot credentials, paid tools or global proxy changes.
 * Conditional GET and Retry-After follow RFC 9110; scheduler mirrors GitHub REST best practices:
 * https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 * asOf 2026-11-02. Source-specific parsers validate 200 bodies before validators are committed.
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const HOSTS = new Set(['openrouter.ai', 'api-docs.deepseek.com', 'docs.bigmodel.cn']);
const blocked = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['::ffff:0:0',96],['64:ff9b::',96],['2002::',16]]) blocked6.addSubnet(ip,bits,'ipv6');
export function allowedFeedUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS.has(url.hostname)) throw new Error('feed_url_not_allowed');
  url.hash = '';
  return url;
}
export function isPublicFeedAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && !blocked6.check(address, 'ipv6');
}
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => !isPublicFeedAddress(a.address))) return callback(new Error('feed_dns_not_public'));
    // DNS result is pinned into the connection; TLS still checks the original hostname.
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
export function retryAfterAt(value, now) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const result = now + Number(text) * 1000;
    return Number.isSafeInteger(result) ? result : null;
  }
  const result = Date.parse(text);
  return Number.isFinite(result) && result > now ? result : null;
}
/** One bounded request, no hidden retry. 30s / 2MiB are explicit provisional safety ceilings,
 * not polling policy; each source's request count is visible in the operational log.
 */
export async function fetchFeedSource(source, state = {}, {
  timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024, now = Date.now(), request = https.request,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  async function get(raw, redirects = 0) {
    const url = allowedFeedUrl(raw);
    const headers = { 'user-agent': 'Megu-feed/0.1 (personal fixed-source monitor)', accept: 'application/json,text/markdown,text/html;q=0.9', 'accept-encoding': 'identity' };
    if (state.etag) headers['if-none-match'] = state.etag;
    if (state.lastModified) headers['if-modified-since'] = state.lastModified;
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const req = request(url, { method: 'GET', headers, lookup: publicLookup }, res => {
        const status = res.statusCode;
        if (status === 304 || (status >= 300 && status < 400)) {
          res.destroy();
          done(null, { status, headers: res.headers, text: '' });
          return;
        }
        if (status !== 200) {
          res.destroy();
          const error = new Error(`feed_http_${status}`);
          error.status = status;
          error.retryAt = retryAfterAt(res.headers['retry-after'], now);
          const reset = Number(res.headers['x-ratelimit-reset']);
          if (res.headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset * 1000 > now) error.retryAt = Math.max(error.retryAt || 0, reset * 1000);
          done(error);
          return;
        }
        if (Number(res.headers['content-length']) > maxBytes) { done(new Error('feed_body_too_large')); res.destroy(); return; }
        let length = 0;
        const chunks = [];
        res.on('data', chunk => {
          length += chunk.length;
          if (length > maxBytes) { done(new Error('feed_body_too_large')); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on('end', () => done(null, { status, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', error => done(error));
        res.on('aborted', () => done(new Error('feed_body_aborted')));
      });
      timer = setTimeout(() => { done(new Error('feed_timeout')); req.destroy(); }, Math.max(1, deadline - Date.now()));
      req.on('error', error => done(error));
      req.end();
    });
    if (result.status !== 304 && result.status >= 300 && result.status < 400) {
      if (redirects >= 3 || !result.headers.location) throw new Error('feed_redirect_invalid');
      const target = allowedFeedUrl(new URL(result.headers.location, url).href);
      // Never replay validators to a different resource: would allow a false 304 baseline.
      if (target.href !== url.href) state = {};
      return get(target.href, redirects + 1);
    }
    return { ...result, etag: result.headers.etag ?? null, lastModified: result.headers['last-modified'] ?? null };
  }
  return get(source.url);
}
