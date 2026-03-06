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
			console.error('notifications/Delete findMany error:', err);
			return { error: 'query_failed' };
		}

		let deleted = 0;
		if (Array.isArray(docs)) {
			for (const doc of docs) {
				try {
					await doc.$odb.remove();
					deleted++;
				} catch (err) {
					console.error('notifications/Delete remove error:', err);
				} finally {
					try { await doc?.$odb?.dispose?.(); } catch (err) {
						console.error('notifications/Delete dispose error:', err);
					}
				}
			}
		}

		const list = sync?.state?.notifications;
		if (Array.isArray(list)) {
			const idSet = new Set(ids);
			for (let i = list.length - 1; i >= 0; i--) {
				const item = list[i];
				if (item?.id && idSet.has(item.id)) {
					list.splice(i, 1);
				}
			}
		}

		return { ok: true, deleted };
	},
});
