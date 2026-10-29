import readline from 'node:readline';
const send = obj => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
const event = (sessionId, type, data) => send({ method: 'session.event', params: { sessionId, event: { type, data } } });
const complete = (sid, id, turn, text) => {
  event(sid, 'turn/start', { turn });
  event(sid, 'user/message', { id, source: { kind: 'user' } });
  event(sid, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
  event(sid, 'turn/end', { turn, reason: { kind: 'completed' } });
};
let oldRequest, hangingSid = 'none', hangingId = 'none';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line), sid = r.params?.sessionId;
  if (r.method === 'initialize') return send({ id: r.id, result: {} });
  if (r.method === 'shutdown') { complete(hangingSid, hangingId, 9, 'LATE-SHUTDOWN-REPLY'); send({ id: r.id, result: {} }); setTimeout(() => process.exit(0), 40); return; }
  if (r.method !== 'session/prompt') return;
  const text = r.params.contentBlocks[0].text, id = 'message-' + r.id;
  if (text === 'FIRST') { oldRequest = r; return; }
  if (text === 'NOACK') return;
  if (text === 'MISSING') return send({ id: r.id, result: {} });
  if (text === 'HANG') { hangingSid = sid; hangingId = id; send({ id: r.id, result: { messageId: id } }); event(sid, 'test/ack-sent', {}); return; }
  if (text === 'SECOND') {
    send({ id: r.id, result: { messageId: id } });
    setTimeout(() => {
      send({ id: oldRequest.id, error: { code: -1, message: 'late rejected old prompt' } });
      complete(sid, 'old-prompt', 1, 'OLD-ONLY');
      complete(sid, 'older-queued', 2, 'FIFO-OLD');
      complete('different-key', id, 3, 'WRONG-KEY');
      complete(sid, id, 3, 'OWN-REPLY');
    }, 10);
    return;
  }
  // All consumption and completion frames deliberately precede the RPC ack.
  complete(sid, id, 4, text === 'THIRD' ? 'NEXT-REPLY' : 'PREACK-REPLY');
  send({ id: r.id, result: { messageId: id } });
});
