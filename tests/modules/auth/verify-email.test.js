import test from 'node:test';
import assert from 'node:assert/strict';

import { OObject } from 'destam';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

const createUserWithId = async (odb, { email, name, emailVerified = false }) => {
	const user = await odb.open({
		collection: 'users',
		value: OObject({
			email,
			name,
			emailVerified,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
		}),
	});
	await user.$odb.flush();
	const id = user.$odb?.key || user.id;
	if (!user.id && id) {
		user.id = id;
		await user.$odb.flush();
	}
	return { user, id };
};

test('auth/VerifyEmail marks user and state as verified', async () => {
	const core = await startCoreTest({
		modules: ['auth/VerifyEmail'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		const { id } = await createUserWithId(core.odb, {
			email: 'verifyme@example.com',
			name: 'Verify Me',
		});

		const state = await core.odb.open({
			collection: 'state',
			query: { filter: { field: 'user', op: 'eq', value: id } },
			value: OObject({ user: id, profile: OObject({ id }) }),
		});
		await state.$odb.flush();

		const token = 'verify-token';
		const verification = await core.odb.open({
			collection: 'emailVerifications',
			value: OObject({
				userId: id,
				email: 'verifyme@example.com',
				token,
				status: 'pending',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1000 * 60 * 10,
				verifiedAt: null,
				completedAt: null,
				sentAt: null,
				emailMessageId: null,
				error: null,
			}),
		});
		await verification.$odb.flush();

		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/VerifyEmail', { token });
		assert.equal(response?.result?.ok, true);

		const userDoc = await core.odb.findOne({
			collection: 'users',
			query: { filter: { field: 'id', op: 'eq', value: id } },
		});
		assert.equal(userDoc?.emailVerified, true);

		const stateDoc = await core.odb.findOne({
			collection: 'state',
			query: { filter: { field: 'user', op: 'eq', value: id } },
		});
		assert.equal(stateDoc?.profile?.emailVerified, true);

		const verifyDoc = await core.odb.findOne({
			collection: 'emailVerifications',
			query: { filter: { field: 'token', op: 'eq', value: token } },
		});
		assert.equal(verifyDoc?.status, 'completed');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});

test('auth/VerifyEmail rejects expired token', async () => {
	const core = await startCoreTest({
		modules: ['auth/VerifyEmail'],
		odbThrottleMs: 0,
	});

	let client;
	try {
		const { id } = await createUserWithId(core.odb, {
			email: 'expired@example.com',
			name: 'Expired User',
		});

		const token = 'expired-token';
		const verification = await core.odb.open({
			collection: 'emailVerifications',
			value: OObject({
				userId: id,
				email: 'expired@example.com',
				token,
				status: 'pending',
				createdAt: Date.now() - 1000 * 60 * 10,
				expiresAt: Date.now() - 1000,
				verifiedAt: null,
				completedAt: null,
				sentAt: null,
				emailMessageId: null,
				error: null,
			}),
		});
		await verification.$odb.flush();

		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/VerifyEmail', { token });
		assert.equal(response?.result?.error, 'expired');

		const verifyDoc = await core.odb.findOne({
			collection: 'emailVerifications',
			query: { filter: { field: 'token', op: 'eq', value: token } },
		});
		assert.equal(verifyDoc?.status, 'expired');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
