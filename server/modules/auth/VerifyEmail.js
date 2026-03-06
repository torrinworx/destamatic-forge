import { OObject } from 'destam';

const ensureString = value => (typeof value === 'string' ? value.trim() : '');
const disposeDoc = async doc => {
	try {
		await doc?.$odb?.dispose?.();
	} catch (err) {
		console.error('auth/VerifyEmail dispose error:', err);
	}
};
const ensureProfileObject = value => (value instanceof OObject ? value : OObject(value && typeof value === 'object' ? value : {}));

const propagateStateEmailVerification = async ({ odb, userId }) => {
	if (!odb || !userId) return;

	let stateDocs;
	try {
		stateDocs = await odb.findMany({
			collection: 'state',
			query: { filter: { field: 'user', op: 'eq', value: userId } },
		});
	} catch (err) {
		console.error('auth/VerifyEmail state propagation fetch error:', err);
		return;
	}

	if (!Array.isArray(stateDocs) || stateDocs.length === 0) return;

	for (const stateDoc of stateDocs) {
		if (!stateDoc) continue;
		try {
			const profile = ensureProfileObject(stateDoc.profile);
			if (profile !== stateDoc.profile) {
				stateDoc.profile = profile;
			}
			profile.emailVerified = true;
			if (!ensureString(profile.id)) {
				const derivedId = ensureString(stateDoc.user) || userId;
				if (derivedId) profile.id = derivedId;
			}

			await stateDoc.$odb?.flush?.();
		} catch (err) {
			console.error('auth/VerifyEmail state propagation error:', err);
		} finally {
			await disposeDoc(stateDoc);
		}
	}
};

export default (injection = {}) => {
	const { odb } = injection;

	return {
		authenticated: false,
		onMessage: async ({ token } = {}) => {
			const cleanToken = ensureString(token);
			if (!cleanToken) return { error: 'invalid_token' };

			let verificationDoc = null;
			let userDoc = null;

			try {
			verificationDoc = await odb.findOne({
				collection: 'emailVerifications',
				query: { filter: { field: 'token', op: 'eq', value: cleanToken } },
			});
				if (!verificationDoc) return { error: 'invalid_token' };

				if (verificationDoc.status === 'completed') {
					return { error: 'already_verified' };
				}

				const now = Date.now();
				const expiresAt = typeof verificationDoc.expiresAt === 'number' ? verificationDoc.expiresAt : 0;
				if (!expiresAt || expiresAt <= now) {
					verificationDoc.status = 'expired';
					verificationDoc.error = 'expired';
					verificationDoc.completedAt = verificationDoc.completedAt ?? now;
					await verificationDoc.$odb.flush();
					return { error: 'expired' };
				}

				const userId = ensureString(verificationDoc.userId) || ensureString(verificationDoc.user);
				if (!userId) {
					verificationDoc.status = 'orphaned';
					verificationDoc.error = 'user_not_found';
					verificationDoc.completedAt = now;
					await verificationDoc.$odb.flush();
					return { error: 'invalid_token' };
				}

			userDoc = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: userId } },
			});
				if (!userDoc) {
					verificationDoc.status = 'orphaned';
					verificationDoc.error = 'user_not_found';
					verificationDoc.completedAt = now;
					await verificationDoc.$odb.flush();
					return { error: 'invalid_token' };
				}

				if (userDoc.emailVerified === true) {
					verificationDoc.status = 'completed';
					verificationDoc.verifiedAt = verificationDoc.verifiedAt ?? now;
					verificationDoc.completedAt = verificationDoc.completedAt ?? now;
					verificationDoc.error = null;
					await verificationDoc.$odb.flush();
					return { error: 'already_verified' };
				}

				userDoc.emailVerified = true;
				userDoc.modifiedAt = now;
				await userDoc.$odb.flush();
				await propagateStateEmailVerification({ odb, userId });

				verificationDoc.status = 'completed';
				verificationDoc.completedAt = now;
				verificationDoc.verifiedAt = now;
				verificationDoc.error = null;
				await verificationDoc.$odb.flush();

				return { ok: true };
			} catch (err) {
				console.error('auth/VerifyEmail error:', err);
				return { error: 'internal_error' };
			} finally {
				await disposeDoc(userDoc);
				await disposeDoc(verificationDoc);
			}
		},
	};
};
