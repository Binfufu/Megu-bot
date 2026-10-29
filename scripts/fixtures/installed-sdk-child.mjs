// Real installed SDK stdio plugin + fake llm/agent ONLY. No profile boot or real provider.
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
let deniedNetworkAttempts = 0, fakeResolveCalls = 0, fakeAgentCreations = 0, forbiddenFallbacks = 0;
const blocked = () => { deniedNetworkAttempts++; throw new Error('stage1 network forbidden'); };
globalThis.fetch = blocked; net.connect = blocked; net.createConnection = blocked;
net.Socket.prototype.connect = blocked; tls.connect = blocked;
http.request = blocked; http.get = blocked; https.request = blocked; https.get = blocked;
syncBuiltinESMExports();
// Negative control proves this guard, not complete OS-level isolation.
try { net.connect({ host: '127.0.0.1', port: 1 }); throw new Error('guard not active'); }
catch (error) { if (error.message !== 'stage1 network forbidden') throw error; }
const { apply } = await import(pathToFileURL(process.env.STAGE1_SDK_SOURCE));
const listeners = new Map(); let cleanup; let turn = 0; let first;
const emit = (event) => listeners.get('session/event')?.({ id: sessionId }, event);
let sessionId;
function consume(message, text, corrupt = false) {
  const n = ++turn;
  emit({ type: 'turn/start', data: { turn: n } });
  emit({ type: 'user/message', data: corrupt ? { ...message, id: 'wrong-identity' } : message });
  emit({ type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text }] } } });
  emit({ type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } });
}
const agent = { id: 'stage1-fake-agent', followup(message) {
  emit({ type: 'test/isolation', data: { deniedNetworkAttempts, fakeResolveCalls, fakeAgentCreations, forbiddenFallbacks } });
  const command = message.content[0].text;
  if (command === 'FIRST') { first = message; return; }
  if (command === 'SECOND') { consume(first, 'OLD-ONLY'); consume(message, 'OWN-REPLY'); return; }
  consume(message, 'PREACK-REPLY', command === 'CORRUPT');
} };
const llm = { listProviders: () => [{ id: 'stage1-fake' }], resolveCallConfig: async config => {
  if (config.provider !== 'stage1-fake') throw new Error('real provider forbidden');
  fakeResolveCalls++;
} };
const ctx = {
  root: { fiber: { dispose: async () => { await cleanup?.(); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'stage1.cleanup', params: { completed: true } }) + '\n'); } } },
  on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
  get(name) { if (name === 'llm') return llm; return undefined; },
  plugin() { forbiddenFallbacks++; throw new Error('provider fallback forbidden'); },
  effect(fn) { cleanup = fn(); },
  agents: { get: id => id === agent.id ? agent : undefined, create: async config => {
    fakeAgentCreations++; sessionId = config.sessionId; return { agent, dispose: async () => {} };
  } },
};
apply(ctx, {});
