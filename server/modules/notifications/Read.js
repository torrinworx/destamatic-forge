export default ({ odb }) => ({
	onMessage: async (props, { user, sync }) => {
		const userId = (() => {
			if (!user) return null;
			const observerId = user.observer?.id;
			if (typeof observerId?.toHex === 'function') {
				const hex = observerId.toHex();
				if (typeof hex === 'string' && hex) return hex;
			}
			if (typeof user.$odb?.key === 'string' && user.$odb.key) return user.$odb.key;
			return typeof user.id === 'string' && user.id ? user.id : null;
		})();
		if (!userId) return { error: 'unauthenticated' };

		const ids = (() => {
			if (typeof props?.id === 'string') return [props.id];
			if (Array.isArray(props?.ids)) return props.ids;
			if (typeof props?.ids?.[Symbol.iterator] === 'function') return [...props.ids];
			return [];
		})()
			.map(value => (typeof value === 'string' ? value.trim() : ''))
			.filter(Boolean);
		if (ids.length === 0) return { error: 'invalid_id' };

		let docs = [];
		try {
			docs = await odb.findMany({
				collection: 'notifications',
				query: {
					filter: {
						and: [
							{ field: 'userId', op: 'eq', value: userId },
							{ field: 'id', op: 'in', value: ids },
						],
					},
				},
			});
		} catch (err) {
			console.error('notifications/Read findMany error:', err);
			return { error: 'query_failed' };
		}

		const now = Date.now();
		let updated = 0;
		if (Array.isArray(docs)) {
			for (const doc of docs) {
				try {
					doc.readAt = now;
					await doc.$odb.flush();
					updated++;
				} catch (err) {
					console.error('notifications/Read update error:', err);
				} finally {
					try { await doc?.$odb?.dispose?.(); } catch (err) {
						console.error('notifications/Read dispose error:', err);
					}
				}
			}
		}

		const list = sync?.state?.notifications;
		if (Array.isArray(list)) {
			for (const item of list) {
				if (item?.id && ids.includes(item.id)) item.readAt = now;
			}
		}

		return { ok: true, updated };
	},
});
