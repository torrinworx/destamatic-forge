import test from 'node:test';
import assert from 'node:assert/strict';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

test('auth/Enter signup creates user, state, and session', async () => {
	process.env.NODE_ENV = 'test';

	const core = await startCoreTest({
		modules: ['auth/Enter'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		client = await createWsClient({ port: core.port });

		const response = await client.send('auth/Enter', {
			email: 'newuser@example.com',
			name: 'New User',
			password: 'strongpass123',
		});

		assert.ok(response?.result?.token, 'Expected token in response');

		const token = response.result.token;
		const session = await core.odb.findOne({
			collection: 'sessions',
			query: { filter: { field: 'uuid', op: 'eq', value: token } },
		});

		assert.ok(session, 'Expected session to exist');

		const user = await core.odb.findOne({
			collection: 'users',
			query: { filter: { field: 'email', op: 'eq', value: 'newuser@example.com' } },
		});

		assert.ok(user, 'Expected user to exist');
		assert.equal(session.user, user.$odb?.key || user.uuid);

		const state = await core.odb.findOne({
			collection: 'state',
			query: { filter: { field: 'user', op: 'eq', value: session.user } },
		});

		assert.ok(state, 'Expected state record to exist');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
