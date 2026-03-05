import { hashPassword, isDevEnv, validatePassword } from './CreatePwd.js';

const ensureString = value => (typeof value === 'string' ? value.trim() : '');
const disposeDoc = async (doc) => {
	try {
		await doc?.$odb?.dispose?.();
	} catch (err) {
		console.error('auth/ResetPwd dispose error:', err);
	}
};

export default () => ({
	authenticated: false,

	onMsg: async ({ token, password } = {}, { odb } = {}) => {
		if (!odb) throw new Error('auth/ResetPwd: odb is required');

		const cleanToken = ensureString(token);
		if (!cleanToken) return { error: 'invalid_token' };

		let resetDoc = null;
		let user = null;

		try {
			resetDoc = await odb.findOne({
				collection: 'pwdResets',
				query: { filter: { field: 'token', op: 'eq', value: cleanToken } },
			});
			if (!resetDoc) return { error: 'invalid_or_expired_token' };

			const now = Date.now();
			const expiresAt = typeof resetDoc.expiresAt === 'number' ? resetDoc.expiresAt : 0;
			const isExpired = expiresAt <= now;
			if (resetDoc.usedAt || isExpired) {
				if (resetDoc.status !== 'expired') resetDoc.status = 'expired';
				resetDoc.error = 'expired';
				resetDoc.usedAt = resetDoc.usedAt ?? now;
				await resetDoc.$odb.flush();
				return { error: 'invalid_or_expired_token' };
			}

			const userId = ensureString(resetDoc.userId) || resetDoc.userId;
			if (!userId) {
				resetDoc.status = 'orphaned';
				resetDoc.usedAt = now;
				resetDoc.error = 'user_not_found';
				await resetDoc.$odb.flush();
				return { error: 'user_not_found' };
			}

			user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: userId } },
			});
			if (!user) {
				resetDoc.status = 'orphaned';
				resetDoc.usedAt = now;
				resetDoc.error = 'user_not_found';
				await resetDoc.$odb.flush();
				return { error: 'user_not_found' };
			}

			const isDev = Boolean(isDevEnv());
			const validation = validatePassword(password, { isDev });
			if (!validation?.ok) {
				return { error: validation?.error || 'invalid_password' };
			}

			const hashed = await hashPassword(validation.value);
			const updatedAt = Date.now();
			user.password = hashed;
			user.modifiedAt = updatedAt;
			await user.$odb.flush();

			resetDoc.status = 'completed';
			resetDoc.usedAt = updatedAt;
			resetDoc.error = null;
			await resetDoc.$odb.flush();

			return { ok: true };
		} catch (err) {
			console.error('auth/ResetPwd error:', err);
			return { error: 'internal_error' };
		} finally {
			await disposeDoc(user);
			await disposeDoc(resetDoc);
		}
	},
});
