import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OObject } from 'destam';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, '..', '..', 'utils', 'overrides');

const createUserWithId = async (odb, { email, name, password }) => {
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
	const id = user.$odb?.key || user.id;
	if (!user.id && id) {
		user.id = id;
		await user.$odb.flush();
	}
	return { user, id };
};

test('auth/GetResetPwd creates reset record and sends email', async () => {
	const core = await startCoreTest({
		modules: ['auth/GetResetPwd'],
		modulesDir: fixturesDir,
		odbThrottleMs: 0,
	});

	let client;
	try {
		await createUserWithId(core.odb, {
			email: 'reset@example.com',
			name: 'Reset User',
			password: 'hash',
		});

		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/GetResetPwd', { email: 'reset@example.com' });
		assert.equal(response?.result?.ok, true);

		const resetDocs = await core.odb.findMany({
			collection: 'pwdResets',
			query: { filter: { field: 'email', op: 'eq', value: 'reset@example.com' } },
		});
		assert.equal(resetDocs.length, 1);
		assert.equal(resetDocs[0].status, 'sent');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});

test('auth/GetResetPwd enforces daily reset limit', async () => {
	const core = await startCoreTest({
		modules: ['auth/GetResetPwd'],
		modulesDir: fixturesDir,
		odbThrottleMs: 0,
	});

	let client;
	try {
		const { id } = await createUserWithId(core.odb, {
			email: 'limit@example.com',
			name: 'Limit User',
			password: 'hash',
		});

		const now = Date.now();
		for (let i = 0; i < 5; i++) {
			const doc = await core.odb.open({
				collection: 'pwdResets',
				value: OObject({
					userId: id,
					email: 'limit@example.com',
					token: `t_${i}`,
					createdAt: now - i * 1000,
					expiresAt: now + 1000 * 60 * 5,
					status: 'sent',
					usedAt: null,
					sentAt: now,
					emailMessageId: null,
					error: null,
				}),
			});
			await doc.$odb.flush();
		}

		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/GetResetPwd', { email: 'limit@example.com' });
		assert.equal(response?.result?.error, 'reset_limit_reached');
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});

test('auth/GetResetPwd returns ok for unknown email without creating reset', async () => {
	const core = await startCoreTest({
		modules: ['auth/GetResetPwd'],
		modulesDir: fixturesDir,
		odbThrottleMs: 0,
	});

	let client;
	try {
		client = await createWsClient({ port: core.port });
		const response = await client.send('auth/GetResetPwd', { email: 'missing@example.com' });
		assert.equal(response?.result?.ok, true);

		const resetDocs = await core.odb.findMany({
			collection: 'pwdResets',
			query: { filter: { field: 'email', op: 'eq', value: 'missing@example.com' } },
		});
		assert.equal(resetDocs.length, 0);
	} finally {
		try { await client?.close?.(); } catch { }
		await core.shutdown();
	}
});
