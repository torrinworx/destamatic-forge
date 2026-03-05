import test from 'node:test';
import assert from 'node:assert/strict';

import { comparePassword, hashPassword, isDevEnv, validatePassword } from '../../../server/modules/auth/CreatePwd.js';

test('auth/CreatePwd validatePassword enforces length in production', async () => {
	process.env.NODE_ENV = 'production';
	process.env.ENV = 'production';

	assert.equal(isDevEnv(), false);

	const missing = validatePassword('', { isDev: false });
	assert.equal(missing.ok, false);
	assert.equal(missing.error, 'Password is required.');

	const short = validatePassword('short', { isDev: false });
	assert.equal(short.ok, false);
	assert.equal(short.error, 'Password must be at least 8 characters.');

	const ok = validatePassword('longenough', { isDev: false });
	assert.equal(ok.ok, true);
});

test('auth/CreatePwd allows empty password in dev mode', async () => {
	process.env.NODE_ENV = 'development';
	process.env.ENV = 'development';

	assert.equal(isDevEnv(), true);

	const ok = validatePassword('', { isDev: true });
	assert.equal(ok.ok, true);
});

test('auth/CreatePwd hashes and compares', async () => {
	const hashed = await hashPassword('secret123');
	assert.ok(typeof hashed === 'string' && hashed.length > 0);

	const good = await comparePassword('secret123', hashed);
	const bad = await comparePassword('wrong', hashed);

	assert.equal(good, true);
	assert.equal(bad, false);
});
