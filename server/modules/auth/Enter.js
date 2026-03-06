import { comparePassword, hashPassword, isDevEnv, normalizePassword, validatePassword } from './CreatePwd.js';
import { OObject } from 'destam';
import UUID from 'destam/UUID.js';

const isValidEmail = email =>
	/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const createSession = async (odb, userId) => {
	const token = UUID().toHex();
	const expires = Date.now() + 1000 * 60 * 60 * 24 * 30;

	const session = await odb.open({
		collection: 'sessions',
		// session documents are keyed by uuid in index for lookup, and also stored as state.uuid
		query: { filter: { field: 'uuid', op: 'eq', value: token } },
		value: OObject({
			uuid: token,
			user: userId,
			expires,
			status: true,
		}),
	});

	await session.$odb.flush();
	return token;
};

export default () => ({
	authenticated: false,

	onMessage: async (props, { odb, extensions }) => {
		const isDev = isDevEnv();
		const input = props || {};
		let { email, name, password, ...extra } = input;

		email = typeof email === 'string' ? email.trim().toLowerCase() : '';
		name = typeof name === 'string' ? name.trim() : '';
		password = normalizePassword(password);

		if (!email) return { error: 'Email is required.' };
		if (!isValidEmail(email)) return { error: 'Please enter a valid email address.' };

		try {
			const user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'email', op: 'eq', value: email } },
			});

			// login
			if (user) {
				const userId = user.$odb?.key || user.uuid; // new system prefers key; keep uuid fallback
				if (!userId) return { error: 'Invalid user record (missing id).' };

				if (!isDev && !password) return { error: 'Password is required.' };
				if (typeof user.password !== 'string' || !user.password) {
					return { error: 'Invalid email or password' };
				}

				const ok = await comparePassword(password, user.password);
				if (!ok) return { error: 'Invalid email or password' };

				return { token: await createSession(odb, userId) };
			}

			// signup
			if (!name) return { error: 'Name is required.' };
			if (name.length > 20) return { error: 'Name must be 20 characters or less.' };

			const passwordValidation = validatePassword(password, { isDev });
			if (!passwordValidation.ok) return { error: passwordValidation.error };
			password = passwordValidation.value;

			const hashedPassword = await hashPassword(password);

			let extensionPatch = null;
			if (typeof extensions?.userProps === 'function') {
				const result = await extensions.userProps({
					props: input,
					extra,
					ctx: { odb },
				});
				if (result?.error) return { error: result.error };
				if (result && typeof result === 'object') extensionPatch = result;
			}

			const newUser = await odb.open({
				collection: 'users',
				value: OObject({
					...(extensionPatch || {}),
					email,
					name,
					password: hashedPassword,
					emailVerified: false,
					createdAt: Date.now(),
					modifiedAt: Date.now(),
				}),
			});
			await newUser.$odb.flush();

			const userId = newUser.$odb?.key;
			if (!userId) return { error: 'user_create_failed_no_id' };

			const state = await odb.open({
				collection: 'state',
				query: { filter: { field: 'user', op: 'eq', value: userId } }, // state is keyed by index.user
				value: OObject({ user: userId }),
			});
			await state.$odb.flush();

			return { token: await createSession(odb, userId) };
		} catch (error) {
			console.error('enter.js error:', error);
			return { error: 'An internal error occurred, please try again later.' };
		}
	},
});
