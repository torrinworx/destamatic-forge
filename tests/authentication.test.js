import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startCoreTest } from './utils/core-harness.js';
import { createWsClient } from './utils/ws-client.js';
import { probeState } from './utils/Probe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('authenticated modules require signed-in user', async () => {
	const core = await startCoreTest({
		modules: ['auth/Enter', 'Probe'],
		modulesDir: [path.resolve(__dirname, 'utils', 'modules')],
		odbThrottleMs: 0,
	});

	probeState.onConnection = 0;
	probeState.onMessage = 0;
	probeState.lastProps = null;

	let anonClient;
	let authedClient;
	try {
		anonClient = await createWsClient({ port: core.port });

		const unauthResponse = await anonClient.send('Probe', { ping: true });
		assert.equal(unauthResponse?.error, 'Unauthorized');
		assert.equal(probeState.onConnection, 0);
		assert.equal(probeState.onMessage, 0);

		const signup = await anonClient.send('auth/Enter', {
			email: 'probe.user@example.com',
			name: 'Probe User',
			password: 'strongpass123',
		});
		assert.ok(signup?.result?.token, 'expected auth/Enter to return token');

		authedClient = await createWsClient({ port: core.port, token: signup.result.token });
		const authMsg = await authedClient.waitForAuth(500);
		assert.equal(authMsg?.ok, true);
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.equal(probeState.onConnection, 1);

		const okResponse = await authedClient.send('Probe', { ping: true });
		assert.deepEqual(okResponse?.result, { ok: true });
		assert.equal(probeState.onMessage, 1);
		assert.deepEqual(probeState.lastProps, { ping: true });
	} finally {
		try { await anonClient?.close?.(); } catch { }
		try { await authedClient?.close?.(); } catch { }
		await core.shutdown();
	}
});
