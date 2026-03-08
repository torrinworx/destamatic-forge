export const defaults = {
	// How long a post remains soft-deleted before cleanup.
	// Stored as epoch milliseconds in `deleteAt`.
	deletionGraceMs: 1000 * 60 * 60 * 24 * 30, // 30 days
};

export default ({ config }) => {
	let deletionGraceMs = config.deletionGraceMs;
	if (!Number.isFinite(deletionGraceMs) || deletionGraceMs < 0) {
		deletionGraceMs = defaults.deletionGraceMs;
	}
	deletionGraceMs = Math.floor(deletionGraceMs);

	return {
		onMessage: async ({ id }, { user, odb }) => {
			if (typeof id !== 'string' || !id.trim()) {
				return { error: 'Invalid id. Must be a non-empty string.' };
			}

			const post = await odb.findOne({
				collection: 'posts',
				query: { filter: { field: 'id', op: 'eq', value: id } },
			});

			if (!post) return { error: 'Post not found.' };

			const userId = user.observer.id.toHex();
			if (!userId) return { error: 'Unauthorized' };

			if (post.user !== userId) {
				return { error: 'Unauthorized' };
			}

			// idempotent: if already soft-deleted, just return the timestamp
			if (post.deleteAt != null) {
				return { ok: true, id: post.$odb?.key ?? id, deleteAt: post.deleteAt };
			}

			const now = Date.now();
			post.deleteAt = now + deletionGraceMs;
			post.modifiedAt = now;

			await post.$odb.flush();

			return { ok: true, id: post.$odb?.key ?? id, deleteAt: post.deleteAt };
		},
	};
};
