import { OObject } from 'destam';
import UUID from 'destam/UUID.js';

export const deps = ['email/Create'];

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export const defaults = {
	subject: 'Verify your email address',
	tokenTtlMs: 1000 * 60 * 60 * 24,
	maxDailyRequests: 5,
	minResendWindowMs: 1000 * 60,
	urls: {
		app: 'https://app.example.com',
	},
};

const ensureString = value => (typeof value === 'string' ? value.trim() : '');
const ensureEmail = value => ensureString(value).toLowerCase();
const clampPositiveInt = (value, fallback) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback);
const sanitizeBaseUrl = value => {
	const clean = ensureString(value);
	if (!clean) return null;
	return clean.endsWith('/') ? clean.slice(0, -1) : clean;
};
const disposeDoc = async doc => {
	try {
		await doc?.$odb?.dispose?.();
	} catch (err) {
		console.error('auth/CreateVerifyEmail dispose error:', err);
	}
};
const ensureId = value => {
	const str = ensureString(value);
	return str || null;
};
const getUserIdFromContext = user => {
	if (!user) return null;
	const observerId = user.observer?.id;
	if (typeof observerId?.toHex === 'function') {
		const hex = observerId.toHex();
		if (typeof hex === 'string' && hex) return hex;
	}
	if (typeof user.$odb?.key === 'string' && user.$odb.key) return user.$odb.key;
	return typeof user.id === 'string' && user.id ? user.id : null;
};

export default ({ odb, webCore, Create }) => {
	const subject = ensureString(webCore.config.subject) || defaults.subject;
	const tokenTtlMs = clampPositiveInt(webCore.config.tokenTtlMs, defaults.tokenTtlMs);
	const maxDailyRequests = clampPositiveInt(webCore.config.maxDailyRequests, defaults.maxDailyRequests);
	const minResendWindowMs = clampPositiveInt(webCore.config.minResendWindowMs, defaults.minResendWindowMs);
	const appUrl = sanitizeBaseUrl(webCore.config.urls?.app ?? defaults.urls.app) ?? defaults.urls.app;

	return {
		authenticated: true,
		onMessage: async (_props, { user }) => {
			const startedAt = Date.now();
			const contextUserId = getUserIdFromContext(user);
			if (!contextUserId) {
				console.log('auth/CreateVerifyEmail unauthenticated');
				return { error: 'unauthenticated' };
			}

			console.log('auth/CreateVerifyEmail start', {
				userId: contextUserId,
			});

			let userDoc = null;
			let verificationDoc = null;

			try {
				userDoc = await odb.findOne({
					collection: 'users',
					query: { filter: { field: 'id', op: 'eq', value: contextUserId } },
				});
				if (!userDoc) {
					console.log('auth/CreateVerifyEmail user_not_found', {
						userId: contextUserId,
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'user_not_found' };
				}

				if (userDoc.emailVerified === true) {
					console.log('auth/CreateVerifyEmail already_verified', {
						userId: contextUserId,
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'already_verified' };
				}

				const normalizedEmail = ensureEmail(userDoc.email);
				if (!normalizedEmail) {
					console.log('auth/CreateVerifyEmail missing_email', {
						userId: contextUserId,
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'missing_email' };
				}

				const resolvedUserId = ensureId(userDoc.$odb?.key) || ensureId(userDoc.id) || contextUserId;
				if (!resolvedUserId) {
					console.log('auth/CreateVerifyEmail user_not_found', {
						userId: contextUserId,
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'user_not_found' };
				}

			const now = Date.now();
			const windowStart = now - ONE_DAY_MS;

				const recentVerifications = await odb.findMany({
					collection: 'emailVerifications',
					query: { filter: { field: 'userId', op: 'eq', value: resolvedUserId } },
				});

			let countedRequests = 0;
			let lastRequestAt = 0;
			let oldestRequestAt = null;

				if (Array.isArray(recentVerifications)) {
					for (const doc of recentVerifications) {
						const createdAt = typeof doc.createdAt === 'number' ? doc.createdAt : 0;
					if (createdAt >= windowStart) {
						countedRequests += 1;
						if (createdAt > lastRequestAt) lastRequestAt = createdAt;
						if (oldestRequestAt == null || createdAt < oldestRequestAt) oldestRequestAt = createdAt;
					}
						await disposeDoc(doc);
					}
				}

				console.log('auth/CreateVerifyEmail recent_verifications', {
					userId: resolvedUserId,
					countedRequests,
					lastRequestAt,
					oldestRequestAt,
					elapsedMs: Date.now() - startedAt,
				});

				if (maxDailyRequests > 0 && countedRequests >= maxDailyRequests) {
					const retryAfter = oldestRequestAt != null ? Math.max(0, (oldestRequestAt + ONE_DAY_MS) - now) : ONE_DAY_MS;
					console.log('auth/CreateVerifyEmail throttled', {
						userId: resolvedUserId,
						retryAfter,
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'throttled', retryAfter };
				}

				if (minResendWindowMs > 0 && lastRequestAt && now - lastRequestAt < minResendWindowMs) {
					console.log('auth/CreateVerifyEmail resend_too_soon', {
						userId: resolvedUserId,
						retryAfter: minResendWindowMs - (now - lastRequestAt),
						elapsedMs: Date.now() - startedAt,
					});
					return { error: 'resend_too_soon', retryAfter: minResendWindowMs - (now - lastRequestAt) };
				}

				const token = UUID().toHex();
				const expiresAt = now + tokenTtlMs;

				verificationDoc = await odb.open({
					collection: 'emailVerifications',
					value: OObject({
						userId: resolvedUserId,
						email: normalizedEmail,
						token,
						status: 'pending',
						createdAt: now,
						expiresAt,
						verifiedAt: null,
						completedAt: null,
						sentAt: null,
						emailMessageId: null,
						error: null,
					}),
				});
				await verificationDoc.$odb.flush();

				console.log('auth/CreateVerifyEmail verification_created', {
					userId: resolvedUserId,
					verificationId: verificationDoc.$odb?.key ?? null,
					expiresAt,
					elapsedMs: Date.now() - startedAt,
				});

				const encodedToken = encodeURIComponent(token);
				const verifyUrl = `${appUrl}/verify-email?token=${encodedToken}`;
				const fallbackUrl = `${appUrl}/auth?verify=${encodedToken}`;

				const displayName = ensureString(userDoc.name);
				const greeting = displayName ? `Hi ${displayName},` : 'Hello,';

				const html = [
					`<p>${greeting}</p>`,
					'<p>Confirm your email address to finish setting up your account.</p>',
					`<p><a href="${verifyUrl}">Verify email address</a></p>`,
					`<p>If the button above does not work, copy and paste this link into your browser:<br>${verifyUrl}</p>`,
					`<p>Fallback link: <a href="${fallbackUrl}">${fallbackUrl}</a></p>`,
				].join('');

				let emailResult;
				try {
					console.log('auth/CreateVerifyEmail send_start', {
						userId: resolvedUserId,
						elapsedMs: Date.now() - startedAt,
					});
					emailResult = await Create({ userId: resolvedUserId, html, subject });
				} catch (err) {
					emailResult = { error: 'send_failed', details: err?.message ?? String(err) };
				}

				const verificationId = verificationDoc.$odb?.key ?? null;

				if (emailResult?.ok) {
					console.log('auth/CreateVerifyEmail send_success', {
						userId: resolvedUserId,
						messageId: ensureString(emailResult.messageId) || null,
						elapsedMs: Date.now() - startedAt,
					});
					const sentAt = Date.now();
					verificationDoc.status = 'sent';
					verificationDoc.sentAt = sentAt;
					verificationDoc.emailMessageId = ensureString(emailResult.messageId) || null;
					verificationDoc.error = null;
					await verificationDoc.$odb.flush();

					return {
						success: true,
						verificationId,
						expiresAt,
						resendAvailableAt: minResendWindowMs > 0 ? now + minResendWindowMs : null,
						remainingRequests: maxDailyRequests > 0 ? Math.max(0, maxDailyRequests - (countedRequests + 1)) : null,
					};
				}

				const errorMessage = ensureString(emailResult?.details) || ensureString(emailResult?.error) || 'send_failed';
				console.log('auth/CreateVerifyEmail send_failed', {
					userId: resolvedUserId,
					error: errorMessage,
					elapsedMs: Date.now() - startedAt,
				});
				verificationDoc.status = 'email_failed';
				verificationDoc.error = errorMessage;
				verificationDoc.sentAt = null;
				verificationDoc.emailMessageId = null;
				await verificationDoc.$odb.flush();
				return { error: 'email_failed', details: errorMessage };
			} catch (err) {
				console.error('auth/CreateVerifyEmail error:', err, {
					userId: contextUserId,
					elapsedMs: Date.now() - startedAt,
				});
				return { error: 'internal_error' };
			} finally {
				console.log('auth/CreateVerifyEmail done', {
					userId: contextUserId,
					elapsedMs: Date.now() - startedAt,
				});
				await disposeDoc(verificationDoc);
				await disposeDoc(userDoc);
			}
		},
	};
};
