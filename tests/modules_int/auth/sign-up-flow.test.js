import test from 'node:test';
import assert from 'node:assert/strict';

import { startCoreTest } from '../../utils/core-harness.js';
import { createWsClient } from '../../utils/ws-client.js';

const callEnter = (client, payload) => client.send('auth/Enter', payload);

test('auth signup flow creates user/state/session and supports login', async () => {
	process.env.NODE_ENV = 'test';

	const core = await startCoreTest({
		modules: ['auth/Enter'],
		odbThrottleMs: 0,
	});

	let signupClient;
	let loginClient;
	try {
		signupClient = await createWsClient({ port: core.port });

		const badCases = [
			{
				name: 'missing email',
				payload: { name: 'User', password: 'strongpass123' },
				expects: 'Email is required.',
			},
			{
				name: 'invalid email',
				payload: { email: 'not-an-email', name: 'User', password: 'strongpass123' },
				expects: 'Please enter a valid email address.',
			},
			{
				name: 'missing name on signup',
				payload: { email: 'missingname@example.com', password: 'strongpass123' },
				expects: 'Name is required.',
			},
			{
				name: 'short password',
				payload: { email: 'shortpass@example.com', name: 'User', password: 'short' },
				expects: 'Password must be at least 8 characters.',
			},
		];

		for (const testCase of badCases) {
			const response = await callEnter(signupClient, testCase.payload);
			assert.equal(
				response?.result?.error,
				testCase.expects,
				`Expected error for ${testCase.name}`
			);
		}

		const signupResponse = await callEnter(signupClient, {
			email: 'flowuser@example.com',
			name: 'Flow User',
			password: 'strongpass123',
		});

		assert.ok(signupResponse?.result?.token, 'Expected token in response');
		const token = signupResponse.result.token;

		const session = await core.odb.findOne({
			collection: 'sessions',
			query: { filter: { field: 'uuid', op: 'eq', value: token } },
		});
		assert.ok(session, 'Expected session to exist');

		const user = await core.odb.findOne({
			collection: 'users',
			query: { filter: { field: 'email', op: 'eq', value: 'flowuser@example.com' } },
		});
		assert.ok(user, 'Expected user to exist');
		assert.equal(session.user, user.$odb?.key || user.uuid);

		const state = await core.odb.findOne({
			collection: 'state',
			query: { filter: { field: 'user', op: 'eq', value: session.user } },
		});
		assert.ok(state, 'Expected state record to exist');

		const loginResponse = await callEnter(signupClient, {
			email: 'flowuser@example.com',
			password: 'strongpass123',
		});
		assert.ok(loginResponse?.result?.token, 'Expected login token');

		const badLogin = await callEnter(signupClient, {
			email: 'flowuser@example.com',
			password: 'wrongpassword',
		});
		assert.equal(badLogin?.result?.error, 'Invalid email or password');

		loginClient = await createWsClient({ port: core.port, token });
		const authMsg = await loginClient.waitForAuth(500);
		assert.equal(authMsg?.ok, true);
	} finally {
		try { await signupClient?.close?.(); } catch { }
		try { await loginClient?.close?.(); } catch { }
		await core.shutdown();
	}
});
