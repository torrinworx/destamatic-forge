import { OArray, OObject } from 'destam';

export const deps = ['email/Create'];

export const defaults = {
	limit: 50,
	allowTest: true,
};

export default ({ odb, webCore, Create }) => {
	const limit = Math.floor(webCore.config.limit);
	const allowTest = webCore.config.allowTest !== false;

	const activeUsers = new Map();

	const registerActive = (userId, notifications) => {
		if (!userId || !notifications) return () => {};
		const set = activeUsers.get(userId) ?? new Set();
		set.add(notifications);
		activeUsers.set(userId, set);

		return () => {
			const cur = activeUsers.get(userId);
			if (!cur) return;
			cur.delete(notifications);
			if (cur.size === 0) activeUsers.delete(userId);
		};
	};

	const pushToActive = (userId, notification) => {
		const targets = activeUsers.get(userId);
		if (!targets) return;
		for (const list of targets) {
			if (!list) continue;
			list.unshift(notification);
			if (list.length > limit) list.splice(limit, list.length - limit);
		}
	};

	const sendEmail = async ({ userId, title, body }) => {
		if (typeof Create !== 'function') return { ok: false, error: 'email_provider_missing' };

		const subject = title || 'Notification';
		const html = [
			`<p>${title || 'Notification'}</p>`,
			`<p>${body || ''}</p>`,
		].join('');

		try {
			const result = await Create({ userId, subject, html });
			if (result?.ok) return { ok: true, messageId: result.messageId ?? null };
			return { ok: false, error: result?.error ?? 'email_failed', details: result?.details };
		} catch (err) {
			return { ok: false, error: 'email_failed', details: err?.message ?? String(err) };
		}
	};

	const internal = async ({ userId, title, body, type, channels }) => {
		const cleanUserId = typeof userId === 'string' ? userId.trim() : '';
		if (!cleanUserId) return { error: 'invalid_user' };

		const cleanTitle = typeof title === 'string' ? title.trim() : '';
		const cleanBody = typeof body === 'string' ? body.trim() : '';
		if (!cleanTitle) return { error: 'invalid_title' };
		if (!cleanBody) return { error: 'invalid_body' };

		const cleanType = typeof type === 'string' && type.trim() ? type.trim() : 'system';
		const channelList = Array.isArray(channels)
			? channels
			: typeof channels === 'string'
				? [channels]
				: (typeof channels?.[Symbol.iterator] === 'function' ? [...channels] : null);
		const resolvedChannels = channelList
			?.map(ch => (typeof ch === 'string' ? ch.trim() : ''))
			.filter(Boolean);
		const channelsToUse = resolvedChannels?.length ? resolvedChannels : ['inApp'];

		let doc = null;
		try {
			const createdAt = Date.now();
			doc = await odb.open({
				collection: 'notifications',
				value: OObject({
					userId: cleanUserId,
					title: cleanTitle,
					body: cleanBody,
					type: cleanType,
					createdAt,
					readAt: null,
					providers: OObject({}),
				}),
			});

			const notification = OObject({
				id: doc?.$odb?.key ?? doc?.id ?? null,
				userId: doc?.userId ?? null,
				title: doc?.title ?? '',
				body: doc?.body ?? '',
				type: doc?.type ?? 'system',
				createdAt: typeof doc?.createdAt === 'number' ? doc.createdAt : Date.now(),
				readAt: typeof doc?.readAt === 'number' ? doc.readAt : null,
				providers: {},
			});

			const providerResults = {};
			for (const channel of channelsToUse) {
				if (channel === 'inApp') continue;
				if (channel === 'email') {
					providerResults.email = await sendEmail({ userId: cleanUserId, title: cleanTitle, body: cleanBody });
					continue;
				}
				providerResults[channel] = { ok: false, error: 'unknown_provider' };
			}

			if (channelsToUse.includes('inApp')) {
				providerResults.inApp = { ok: true };
				notification.providers = providerResults;
				pushToActive(cleanUserId, notification);
			}

			doc.providers = OObject(providerResults);
			await doc.$odb.flush();

			return { ok: true, id: doc.$odb?.key ?? null, providers: providerResults };
		} catch (err) {
			console.error('notifications/Create internal error:', err);
			return { error: 'internal_error' };
		} finally {
			try { await doc?.$odb?.dispose?.(); } catch (err) {
				console.error('notifications/Create dispose error:', err);
			}
		}
	};

	return {
		internal,
		onConnection: async ({ sync, user }) => {
			if (!sync?.state) return null;
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
			if (!userId) return null;

			const state = sync.state;
			const notifications = state.notifications instanceof OArray
				? state.notifications
				: (Array.isArray(state.notifications) ? OArray([...state.notifications]) : OArray([]));
			state.notifications = notifications;

			let docs = [];
			try {
				docs = await odb.findMany({
					collection: 'notifications',
					query: { filter: { field: 'userId', op: 'eq', value: userId } },
				});
			} catch (err) {
				console.error('notifications/Create onConnection findMany error:', err);
			}

			const serialized = [];
			if (Array.isArray(docs)) {
				for (const doc of docs) {
					serialized.push(OObject({
						id: doc?.$odb?.key ?? doc?.id ?? null,
						userId: doc?.userId ?? null,
						title: doc?.title ?? '',
						body: doc?.body ?? '',
						type: doc?.type ?? 'system',
						createdAt: typeof doc?.createdAt === 'number' ? doc.createdAt : Date.now(),
						readAt: typeof doc?.readAt === 'number' ? doc.readAt : null,
						providers: doc?.providers ?? {},
					}));
					try { await doc?.$odb?.dispose?.(); } catch (err) {
						console.error('notifications/Create dispose error:', err);
					}
				}
			}

			serialized.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
			const trimmed = serialized.slice(0, limit);
			notifications.splice(0, notifications.length, ...trimmed);

			return registerActive(userId, notifications);
		},
			onMessage: async (props, { user }) => {
			if (!allowTest) return { error: 'test_disabled' };
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

			const channel = typeof props?.channel === 'string' ? props.channel.trim() : '';
			const channels = props?.channels ?? (channel ? [channel] : null);

			return await internal({
				userId,
				title: props?.title,
				body: props?.body,
				type: props?.type,
				channels,
			});
		},
	};
};
