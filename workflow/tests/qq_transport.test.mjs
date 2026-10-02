import test from 'node:test';
import assert from 'node:assert/strict';
import { createQqTransport } from '../tools/notification/qq_transport.mjs';

const config = { appId: 'fixture-app', clientSecret: 'fixture-secret', targetType: 'user', targetId: 'fixture-openid' };
const payload = { msg_type: 2, markdown: { content: '# PaperEcho 通知测试 🧪' } };
const tokenResponse = { access_token: 'fixture-token', expires_in: 7200 };
const messageResponse = { id: 'fixture-message', timestamp: '2026-09-30T12:00:00+08:00' };
function fake(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    assert.ok(value, 'Unexpected HTTP request');
    return { status: value.status ?? 200, json: async () => value.body };
  };
  return { calls, fetchImpl };
}
function assertRedacted(result) {
  const serialized = JSON.stringify(result);
  for (const sensitive of [config.clientSecret, 'fixture-token', config.targetId, 'provider-sensitive-message']) assert.equal(serialized.includes(sensitive), false);
}

test('QQ retains the exact legacy text provider schema for verified old receipts', async () => {
  const http = fake([{ body: tokenResponse }, { body: messageResponse }]);
  const legacy = { msg_type: 0, content: 'PaperEcho 历史摘要' };
  assert.equal((await createQqTransport(config, http)(legacy)).accepted, true);
  assert.deepEqual(http.calls[1].body, legacy);
});

for (const targetType of ['user', 'group']) test(`QQ ${targetType} uses official active Markdown wire format`, async () => {
  const http = fake([{ body: tokenResponse }, { body: messageResponse }]);
  const send = createQqTransport({ ...config, targetType, targetId: 'fixture/id?' }, http);
  const result = await send({ ...payload, to: 'internal-recipient', messageId: 'internal-identity' });
  assert.deepEqual(result, { accepted: true, acceptedCount: 1, rejectedCount: 0, category: 'accepted', responseCode: 200 });
  assert.equal(http.calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(http.calls[0].body, { appId: config.appId, clientSecret: config.clientSecret });
  assert.equal(http.calls[0].init.headers.Authorization, undefined);
  assert.equal(http.calls[1].url, `https://api.bot.qq.com/v2/${targetType === 'user' ? 'users' : 'groups'}/fixture%2Fid%3F/messages`);
  assert.deepEqual(http.calls[1].body, payload);
  assert.equal(http.calls[1].init.headers.Authorization, 'QQBot fixture-token');
  assert.equal(http.calls[1].init.redirect, 'error');
  assertRedacted(result);
});

for (const [code, category] of [[100016, 'qq_authentication'], [100001, 'qq_rate_limited']]) test(`QQ token rejection ${code} cannot send`, async () => {
  const http = fake([{ body: { code, message: 'provider-sensitive-message' } }]);
  const result = await createQqTransport(config, http)(payload);
  assert.equal(result.accepted, false);
  assert.equal(result.category, category);
  assert.equal(http.calls.length, 1);
  assertRedacted(result);
});

for (const [code, category, accepted] of [
  [40054004, 'qq_invalid_destination', false], [40034105, 'qq_authorization', false],
  [40034100, 'qq_rate_limited', false], [40054007, 'qq_invalid_payload', false],
  [50055002, 'qq_provider_unavailable', undefined], [999999, 'qq_unknown', undefined],
]) test(`QQ provider error ${code} normalizes without leaking response`, async () => {
  const http = fake([{ body: tokenResponse }, { body: { err_code: code, message: 'provider-sensitive-message', trace_id: 'fixture-token' } }]);
  const result = await createQqTransport(config, http)(payload);
  assert.equal(result.accepted, accepted);
  assert.equal(result.category, category);
  assert.equal(http.calls.length, 2);
  assertRedacted(result);
});

test('QQ invalid configuration and payload never acquire token', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error('must not call'); } };
  for (const invalid of [{ targetType: 'guild' }, { targetId: '' }, { targetId: '\n' }, { clientSecret: '' }, { appId: '' }]) {
    assert.equal((await createQqTransport({ ...config, ...invalid }, options)(payload)).category, 'qq_configuration_invalid');
  }
  const send = createQqTransport(config, options);
  for (const invalid of [null, {}, { ...payload, msg_type: 0 }, { ...payload, markdown: { content: '' } }, { ...payload, content: 'forbidden' }, { ...payload, markdown: { content: 'x', custom_template_id: 'forbidden' } }, { ...payload, keyboard: {} }, { ...payload, apiUrl: 'https://example.com' }]) {
    assert.equal((await send(invalid)).category, 'qq_invalid_payload');
  }
  assert.equal(calls, 0);
});

test('QQ lost send response is unknown; acquisition failure is definitely unsent', async () => {
  for (const beforeSend of [true, false]) {
    const http = fake(beforeSend ? [new Error('fixture-secret')] : [{ body: tokenResponse }, new Error('fixture-secret')]);
    const result = await createQqTransport(config, http)(payload);
    assert.equal(result.accepted, beforeSend ? false : undefined);
    assert.equal(result.category, 'qq_network');
    assertRedacted(result);
  }
});

test('QQ malformed or server send response stays unknown', async () => {
  for (const response of [{ body: null }, { body: [] }, { body: {} }, { body: { ...messageResponse, err_code: 'bad' } },
    { body: { ...messageResponse, timestamp: 'bad' } }, { status: 500, body: messageResponse }, { status: 202, body: messageResponse }]) {
    const http = fake([{ body: tokenResponse }, response]);
    const result = await createQqTransport(config, http)(payload);
    assert.equal(result.accepted, undefined);
    assertRedacted(result);
  }
});

test('QQ malformed token is never cached or used', async () => {
  for (const body of [{ ...tokenResponse, code: 'bad' }, { ...tokenResponse, expires_in: true },
    { ...tokenResponse, expires_in: 0 }, { ...tokenResponse, access_token: 'unsafe\r\nheader' }]) {
    const http = fake([{ body }]);
    const result = await createQqTransport(config, http)(payload);
    assert.equal(result.accepted, false);
    assert.equal(http.calls.length, 1);
    assertRedacted(result);
  }
});

test('QQ abort deadline keeps an uncertain send unknown and does not retry', async () => {
  let calls = 0;
  const send = createQqTransport(config, { timeoutMs: 10, fetchImpl: async (_url, init) => {
    if (++calls === 1) return { status: 200, json: async () => tokenResponse };
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('deadline not enforced')), 500);
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
    });
  } });
  const result = await send(payload);
  assert.equal(result.accepted, undefined);
  assert.equal(result.category, 'qq_network');
  assert.equal(calls, 2);
});

test('QQ token is memory cached and refreshed during last minute', async () => {
  let now = 0;
  const http = fake([{ body: tokenResponse }, { body: messageResponse }, { body: messageResponse },
    { body: { access_token: 'fixture-refreshed-token', expires_in: '7200' } }, { body: messageResponse }]);
  const send = createQqTransport(config, { ...http, clock: () => now });
  await send(payload);
  now = 7139000;
  await send(payload);
  assert.equal(http.calls.length, 3);
  now = 7140000;
  await send(payload);
  assert.equal(http.calls.length, 5);
  assert.equal(http.calls[4].init.headers.Authorization, 'QQBot fixture-refreshed-token');
});

test('QQ failed authentication invalidates token for the next explicit attempt', async () => {
  const http = fake([{ body: tokenResponse }, { status: 401, body: { err_code: 11251 } },
    { body: { access_token: 'fixture-refreshed-token', expires_in: 7200 } }, { body: messageResponse }]);
  const send = createQqTransport(config, http);
  assert.equal((await send(payload)).category, 'qq_authentication');
  assert.equal(http.calls.length, 2);
  assert.equal((await send(payload)).accepted, true);
  assert.equal(http.calls.length, 4);
});

test('QQ concurrent calls share only token acquisition, without hidden send dedupe', async () => {
  const http = fake([{ body: tokenResponse }, { body: messageResponse }, { body: messageResponse }]);
  const send = createQqTransport(config, http);
  const results = await Promise.all([send(payload), send(payload)]);
  assert.equal(results.every(result => result.accepted), true);
  assert.equal(http.calls.filter(call => call.url.endsWith('/app/getAppAccessToken')).length, 1);
  assert.equal(http.calls.length, 3);
});
