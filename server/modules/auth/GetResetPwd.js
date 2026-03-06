import { OObject } from 'destam';
import UUID from 'destam/UUID.js';

export const deps = ['email/Create'];

export const defaults = {
	clientUrl: 'https://app.example.com/reset-password',
	tokenTtlMs: 1000 * 60 * 60,
	maxEmailsPerDay: 5,
	subject: 'Reset your password',
};

const ONE_DAY = 1000 * 60 * 60 * 24;
const ensureString = (v) => (typeof v === 'string' ? v.trim() : '');
const disposeDoc = async (doc) => {
	try {
		await doc?.$odb?.dispose?.();
	} catch (err) {
		console.error('auth/GetResetPwd dispose error:', err);
	}
};
const clampPositiveInt = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);

export default (injection = {}) => {
	const { odb, webCore, Create } = injection;

	const clientUrl = ensureString(webCore.config.clientUrl) || defaults.clientUrl;
	const tokenTtlMs = clampPositiveInt(webCore.config.tokenTtlMs, defaults.tokenTtlMs);
	const maxEmailsPerDay = clampPositiveInt(webCore.config.maxEmailsPerDay, defaults.maxEmailsPerDay);
	const subject = ensureString(webCore.config.subject) || defaults.subject;

	return {
		authenticated: false,

		onMessage: async ({ email }) => {
			const normalizedEmail = ensureString(email).toLowerCase();
			if (!normalizedEmail) return { error: 'invalid_email' };

			let user = null;
			let resetDoc = null;

			try {
			user = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'email', op: 'eq', value: normalizedEmail } },
			});
				if (!user) return { ok: true };

				const userId = user.$odb?.key || user.id || user.uuid || null;
				if (!userId) return { error: 'user_not_found' };

				const windowStart = Date.now() - ONE_DAY;
			const recentResets = await odb.findMany({
				collection: 'pwdResets',
				query: {
					filter: {
						and: [
							{ field: 'userId', op: 'eq', value: userId },
							{ field: 'createdAt', op: 'gte', value: windowStart },
						],
					},
				},
			});
				let resetCount = 0;
				if (Array.isArray(recentResets)) {
					for (const doc of recentResets) {
						resetCount += 1;
						await disposeDoc(doc);
					}
				}
				if (resetCount >= maxEmailsPerDay) {
					return { error: 'reset_limit_reached' };
				}

				const token = UUID().toHex();
				const createdAt = Date.now();
				const expiresAt = createdAt + tokenTtlMs;

				resetDoc = await odb.open({
					collection: 'pwdResets',
					value: OObject({
						userId,
						email: normalizedEmail,
						token,
						createdAt,
						expiresAt,
						usedAt: null,
						status: 'pending',
						sentAt: null,
						emailMessageId: null,
						error: null,
					}),
				});
				await resetDoc.$odb.flush();

				const separator = clientUrl.includes('?') ? '&' : '?';
				const resetUrl = `${clientUrl}${separator}token=${encodeURIComponent(token)}`;

				const userName = ensureString(user.name);
				const greeting = userName ? `Hi ${userName},` : 'Hello,';
				const html = [
					`<p>${greeting}</p>`,
					'<p>We received a request to reset your password. Use the link below:</p>',
					`<p><a href="${resetUrl}">${resetUrl}</a></p>`,
					'<p>If you did not request this, you can safely ignore this email.</p>',
				].join('');

				let emailResult;
				try {
					emailResult = await Create({ userId, html, subject });
				} catch (err) {
					console.error('auth/GetResetPwd email error:', err);
					emailResult = { error: 'send_failed', details: err?.message ?? String(err) };
				}

				if (emailResult?.ok) {
					const sentAt = Date.now();
					resetDoc.status = 'sent';
					resetDoc.sentAt = sentAt;
					resetDoc.emailMessageId = ensureString(emailResult.messageId) || null;
					resetDoc.error = null;
					await resetDoc.$odb.flush();
					return { ok: true };
				}
				console.log(emailResult);
				const errorMessage = ensureString(emailResult?.details) || ensureString(emailResult?.error) || 'send_failed';
				console.log(errorMessage);
				resetDoc.status = 'email_failed';
				resetDoc.error = errorMessage;
				resetDoc.sentAt = null;
				resetDoc.emailMessageId = null;
				await resetDoc.$odb.flush();
				return { error: 'email_failed' };
			} catch (err) {
				console.error('auth/GetResetPwd error:', err);
				return { error: 'internal_error' };
			} finally {
				await disposeDoc(resetDoc);
				await disposeDoc(user);
			}
		},
	};
};
