import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject } from 'destam';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

const createUser = async (odb, { email, name, password }) => {
	const user = await odb.open({
		collection: 'users',
		value: OObject({
			email,
			name,
			password,
			emailVerified: false,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
		}),
	});
	await user.$odb.flush();
	user.id = user.$odb?.key || user.id;
	await user.$odb.flush();
	return user;
};

test('auth/ResetPwd updates password and completes reset doc', async () => {
	process.env.NODE_ENV = 'test';

	const core = await startCoreTest({
		modules: ['auth/ResetPwd'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		const user = await createUser(core.odb, {
			email: 'reset@example.com',
			name: 'Reset User',
			password: 'old-hash',
		});

		const token = 'reset-token-1';
		const resetDoc = await core.odb.open({
			collection: 'pwdResets',
			value: OObject({
				userId: user.id,
				email: 'reset@example.com',
				token,
				createdAt: Date.now(),
				expiresAt: Date.now() + 1000 * 60 * 10,
				usedAt: null,
				status: 'pending',
				sentAt: null,
				emailMessageId: null,
				error: null,
			}),
		});
		await resetDoc.$odb.flush();

		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/ResetPwd', {
			token,
			password: 'newpassword123',
		});

		assert.equal(response?.result?.ok, true);

		await user.$odb.reload();
		assert.notEqual(user.password, 'old-hash');

		const updatedReset = await core.odb.findOne({
			collection: 'pwdResets',
			query: { filter: { field: 'token', op: 'eq', value: token } },
		});
		assert.equal(updatedReset?.status, 'completed');
		assert.ok(updatedReset?.usedAt);
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});

test('auth/ResetPwd rejects invalid token', async () => {
	const core = await startCoreTest({
		modules: ['auth/ResetPwd'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/ResetPwd', { token: 'missing', password: 'newpassword123' });
		assert.equal(response?.result?.error, 'invalid_or_expired_token');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
