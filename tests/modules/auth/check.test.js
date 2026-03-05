import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject } from 'destam';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

test('auth/Check returns true for existing user, false otherwise', async () => {
	const core = await startCoreTest({
		modules: ['auth/Check'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		const user = await core.odb.open({
			collection: 'users',
			value: OObject({
				email: 'exists@example.com',
				name: 'Exists',
				password: 'hashed',
				createdAt: Date.now(),
				modifiedAt: Date.now(),
			}),
		});
		await user.$odb.flush();

		client = await createWsClient({ port: core.port });

		const found = await client.send('auth/Check', { email: 'exists@example.com' });
		assert.equal(found?.result, true);

		const missing = await client.send('auth/Check', { email: 'missing@example.com' });
		assert.equal(missing?.result, false);
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
