import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OObject } from 'destam';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '..', '..', 'utils', 'modules-config');

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

const createSession = async (odb, { userId, token }) => {
	const session = await odb.open({
		collection: 'sessions',
		query: { filter: { field: 'uuid', op: 'eq', value: token } },
		value: OObject({
			uuid: token,
			user: userId,
			expires: Date.now() + 1000 * 60 * 60,
			status: true,
		}),
	});
	await session.$odb.flush();
};

test('auth/CreateVerifyEmail issues verification email for authed user', async () => {
	const core = await startCoreTest({
		modules: ['auth/CreateVerifyEmail'],
		modulesDir: fixturesDir,
		odbThrottleMs: 0,
	});

	let client;
	try {
		const { id } = await createUserWithId(core.odb, {
			email: 'verify@example.com',
			name: 'Verify User',
		});

		const token = 'verify-session-token';
		await createSession(core.odb, { userId: id, token });

		client = await createWsClient({ port: core.port, token });
		const response = await client.send('auth/CreateVerifyEmail');
		assert.equal(response?.result?.success, true);

		const docs = await core.odb.findMany({
			collection: 'emailVerifications',
			query: { filter: { field: 'userId', op: 'eq', value: id } },
		});
		assert.equal(docs.length, 1);
		assert.equal(docs[0].status, 'sent');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});

test('auth/CreateVerifyEmail rejects already verified users', async () => {
	const core = await startCoreTest({
		modules: ['auth/CreateVerifyEmail'],
		modulesDir: fixturesDir,
		odbThrottleMs: 0,
	});

	let client;
	try {
		const { id } = await createUserWithId(core.odb, {
			email: 'verified@example.com',
			name: 'Verified User',
			emailVerified: true,
		});

		const token = 'verified-session-token';
		await createSession(core.odb, { userId: id, token });

		client = await createWsClient({ port: core.port, token });
		const response = await client.send('auth/CreateVerifyEmail');
		assert.equal(response?.result?.error, 'already_verified');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
