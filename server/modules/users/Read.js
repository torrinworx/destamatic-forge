const toArray = (input) => {
	if (input == null) return null;
	if (Array.isArray(input)) return input;
	if (typeof input?.[Symbol.iterator] === 'function') return [...input];
	return null;
};

const normalizeId = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const toUserInfo = (user) => ({
	id: user.$odb?.key ?? user.id ?? null,
	name: user.name ?? '',
	emailVerified: user.emailVerified === true,
	image: user.image ?? user.profileImage ?? null,
	description: typeof user.description === 'string' ? user.description : '',
	socialLinks: user.socialLinks,
});

export default () => ({
	authenticated: false,

	onMsg: async ({ id, ids }, { odb }) => {
		if (!odb) throw new Error('users/Read: odb not provided');

		const singleId = normalizeId(id);
		const multiIds = toArray(ids);

		if (singleId) {
			const user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: singleId } },
			});
			if (!user) return null;

			const out = toUserInfo(user);
			await user.$odb.dispose();
			return out;
		}

		if (multiIds) {
			const clean = multiIds
				.map(normalizeId)
				.filter(Boolean);

			if (!clean.length) return [];

			const users = await odb.findMany({
				collection: 'users',
				query: { filter: { field: 'id', op: 'in', value: clean } },
			});
			const map = new Map();
			for (const user of users) {
				const key = user.$odb?.key ?? user.id ?? null;
				if (key) map.set(key, toUserInfo(user));
				await user.$odb.dispose();
			}

			return clean.map(uid => map.get(uid) ?? null);
		}

		return { error: 'Invalid id' };
	},
});
