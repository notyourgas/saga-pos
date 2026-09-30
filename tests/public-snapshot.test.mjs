import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPosAlphaServer } from '../src/pos-alpha/server.mjs';

test('local source snapshot serves UI, catalog and synthetic assets and preserves owner authentication', async () => {
  const sharedPassword = randomBytes(18).toString('base64url');
  const { server } = createPosAlphaServer({ sharedPassword });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/api/health','/api/menu/catalog','/kiosk','/cashier','/admin','/dashboard','/hr','/staff']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.ok((await response.text()).length > 0, route);
    }
    const assetRoot = fileURLToPath(new URL('../public/pos-alpha/assets/', import.meta.url));
    async function visit(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(p);
        else if (entry.name.endsWith('.svg')) {
          const route = '/assets/' + path.relative(assetRoot, p).split(path.sep).join('/');
          const response = await fetch(base + route);
          assert.equal(response.status, 200, route);
          assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
        }
      }
    }
    await visit(assetRoot);
    for (const version of ['v1','v2','v3']) {
      const manifest = JSON.parse(await readFile(path.join(assetRoot, `menu/${version}/manifest.json`), 'utf8'));
      for (const asset of [...manifest.illustrativeDummyAssets || [], ...manifest.candidateAssets || []]) {
        assert.match(asset.file, /\.svg$/);
        assert.equal((await fetch(base + `/assets/menu/${version}/` + asset.file)).status, 200, asset.file);
      }
    }
    const serviceWorker = await readFile(new URL('../public/pos-alpha/staff-sw.js', import.meta.url), 'utf8');
    const shell = serviceWorker.match(/const SHELL = Object.freeze\(\[([\s\S]*?)\]\)/)[1];
    for (const match of shell.matchAll(/'([^']+)'/g)) {
      assert.equal((await fetch(base + match[1])).status, 200, `staff offline shell: ${match[1]}`);
    }
    const login = password => fetch(base + '/api/operator/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ organizationSlug: 'kopi-saga', employeeId: 'OWNER-DEMO', password })
    });
    assert.equal((await login(randomBytes(18).toString('base64url'))).status, 401);
    const accepted = await login(sharedPassword);
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get('set-cookie'), /HttpOnly/i);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
