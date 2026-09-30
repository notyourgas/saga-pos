import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPosAlphaServer } from '../src/pos-alpha/server.mjs';

test('native HTTP request key and recovery lookup ship with the browser module', async () => {
  const password = randomBytes(24).toString('base64url');
  const subject = { staffId: randomUUID(), name: 'Synthetic Staff', role: 'cashier', passwordChangeRequired: false };
  let submissions = 0;
  const receipts = new Map();
  const nativeStaff = {
    login: async input => {
      assert.equal(input.password, password);
      return subject;
    },
    validateSession: async input => input,
    submitRequest: async (staffId, input) => {
      assert.equal(staffId, subject.staffId);
      submissions++;
      if (!receipts.has(input.idempotencyKey)) receipts.set(input.idempotencyKey, { id: randomUUID() });
      return receipts.get(input.idempotencyKey);
    },
    requestOperationStatus: async (staffId, key) => {
      assert.equal(staffId, subject.staffId);
      return { status: receipts.has(key) ? 'COMMITTED' : 'NOT_FOUND', request: receipts.get(key) || null };
    }
  };
  const { server } = createPosAlphaServer({ nativeStaff });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const module = await fetch(base + '/ui/staff-request-attempt.js');
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.match(await module.text(), /export function createRequestAttempt/);
    const login = await fetch(base + '/api/staff/native/login', {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const csrfToken = (await login.json()).csrfToken;
    const key = randomUUID();
    const headers = { origin: base, cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken };
    const post = input => fetch(base + '/api/staff/native/request', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal((await post({ category: 'permission' })).status, 422);
    assert.equal((await post({ idempotencyKey: 'invalid' })).status, 422);
    assert.equal(submissions, 0);
    const lookup = () => fetch(base + `/api/staff/native/request-operation?idempotencyKey=${key}`, { headers: { cookie } });
    assert.equal((await (await lookup()).json()).data.status, 'NOT_FOUND');
    const accepted = await post({ idempotencyKey: key, category: 'permission' });
    assert.equal(accepted.status, 201);
    const receipt = (await accepted.json()).data;
    assert.equal((await (await lookup()).json()).data.request.id, receipt.id);
    const replay = await post({ idempotencyKey: key, category: 'permission' });
    assert.equal((await replay.json()).data.id, receipt.id);
    assert.equal((await fetch(base + `/api/staff/native/request-operation?idempotencyKey=${key}`)).status, 401);
    assert.equal((await fetch(base + `/api/staff/native/request-operation?idempotencyKey=${key}&idempotencyKey=${key}`, { headers: { cookie } })).status, 422);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
