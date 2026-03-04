const isPlainObject = (v) =>
	v && typeof v === 'object' && (v.constructor === Object || Object.getPrototypeOf(v) === null);

const toUserId = (user) =>
	user?.$odb?.key ?? user?.observer?.id?.toHex?.() ?? null;

const toArray = (input) => {
	if (input == null) return null;
	if (Array.isArray(input)) return input;
	if (typeof input?.[Symbol.iterator] === 'function') return [...input];
	return null;
};

const serializePost = (post) => {
	const out = JSON.parse(JSON.stringify(post));
	if (!isPlainObject(out)) return { id: post.$odb?.key ?? null };
	out.id = post.$odb?.key ?? out.id;
	return out;
};

const hasDeleteAt = (post) => typeof post?.deleteAt === 'number';
const matchesDeletedState = (post, deleted, userId) => {
	const deletedFlag = hasDeleteAt(post);
	if (deleted && userId) {
		if (post.user !== userId) return false;
	}
	return deleted ? deletedFlag : !deletedFlag;
};

const summarizePost = async (post, { deleted, userId }) => {
	if (!post) return null;
	if (!matchesDeletedState(post, deleted, userId)) {
		await post.$odb.dispose();
		return null;
	}
	const serialized = serializePost(post);
	await post.$odb.dispose();
	return serialized;
};

export default () => ({
	authenticated: false,

	onMsg: async (props, ctx) => {
		const p = props || {};
		const odb = ctx?.odb;
		if (!odb) throw new Error('posts/Read: odb not provided');

		const deleted = p?.deleted === true;
		const userId = toUserId(ctx?.user);

		if (deleted && !userId) {
			return { error: 'Unauthorized' };
		}

		const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : null;
		const ids = toArray(p.ids);

		const limit = Number.isFinite(p.limit) ? Math.max(0, Math.floor(p.limit)) : undefined;
		const skip = Number.isFinite(p.skip) ? Math.max(0, Math.floor(p.skip)) : undefined;

		if (id) {
			const post = await odb.findOne({
				collection: 'posts',
				query: { id },
			});
			const serialized = await summarizePost(post, { deleted, userId });
			if (!serialized) return false;
			return serialized;
		}

		if (ids) {
			const clean = ids.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
			if (clean.length === 0) return [];

			const map = new Map();
			for (const pid of clean) {
				const post = await odb.findOne({
					collection: 'posts',
					query: { id: pid },
				});
				const serialized = await summarizePost(post, { deleted, userId });
				if (serialized) map.set(pid, serialized);
			}

			return clean.map(pid => map.get(pid) ?? null);
		}
		if (!deleted) {
			return [];
		}

		const query = { user: userId };
		const posts = await odb.findMany({ collection: 'posts', query });
		const deletedPosts = [];
		for (const post of posts) {
			const serialized = await summarizePost(post, { deleted, userId });
			if (serialized) deletedPosts.push(serialized);
		}

		const start = typeof skip === 'number' ? skip : 0;
		const end = typeof limit === 'number' ? start + limit : undefined;
		return deletedPosts.slice(start, end);
	},
});
