import { OObject } from 'destam';
import UUID from 'destam/UUID.js';

export const deps = ['email/Create'];

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const DEFAULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;
const MAX_DAILY_REQUESTS = 5;
const MIN_RESEND_WINDOW_MS = 1000 * 60;
const DEFAULT_SUBJECT = 'Verify your email address';
const DEFAULT_APP_URL = 'https://app.example.com';

export const defaults = {
	subject: DEFAULT_SUBJECT,
	tokenTtlMs: DEFAULT_TOKEN_TTL_MS,
	maxDailyRequests: MAX_DAILY_REQUESTS,
	minResendWindowMs: MIN_RESEND_WINDOW_MS,
	urls: {
		app: DEFAULT_APP_URL,
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

export default (injection = {}) => {
	const { odb, webCore, Create } = injection;
	if (!odb) throw new Error('auth/CreateVerifyEmail: odb is required');
	if (typeof Create !== 'function') throw new Error('auth/CreateVerifyEmail: email/Create dependency missing');

	const cfg = webCore?.config ?? {};
	const subject = ensureString(cfg.subject) || DEFAULT_SUBJECT;
	const tokenTtlMs = clampPositiveInt(cfg.tokenTtlMs, DEFAULT_TOKEN_TTL_MS);
	const maxDailyRequests = clampPositiveInt(cfg.maxDailyRequests, MAX_DAILY_REQUESTS);
	const minResendWindowMs = clampPositiveInt(cfg.minResendWindowMs, MIN_RESEND_WINDOW_MS);
	const urlsCfg = cfg.urls ?? {};
	const appUrl = sanitizeBaseUrl(urlsCfg.app ?? DEFAULT_APP_URL) ?? DEFAULT_APP_URL;

	return {
		authenticated: true,
		onMsg: async (_props, { user }) => {
			const contextUserId = getUserIdFromContext(user);
			if (!contextUserId) return { error: 'unauthenticated' };

			let userDoc = null;
			let verificationDoc = null;

			try {
			userDoc = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: contextUserId } },
			});
				if (!userDoc) return { error: 'user_not_found' };

				if (userDoc.emailVerified === true) return { error: 'already_verified' };

				const normalizedEmail = ensureEmail(userDoc.email);
				if (!normalizedEmail) return { error: 'missing_email' };

				const resolvedUserId = ensureId(userDoc.$odb?.key) || ensureId(userDoc.id) || contextUserId;
				if (!resolvedUserId) return { error: 'user_not_found' };

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

				if (maxDailyRequests > 0 && countedRequests >= maxDailyRequests) {
					const retryAfter = oldestRequestAt != null ? Math.max(0, (oldestRequestAt + ONE_DAY_MS) - now) : ONE_DAY_MS;
					return { error: 'throttled', retryAfter };
				}

				if (minResendWindowMs > 0 && lastRequestAt && now - lastRequestAt < minResendWindowMs) {
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
					emailResult = await Create({ userId: resolvedUserId, html, subject });
				} catch (err) {
					emailResult = { error: 'send_failed', details: err?.message ?? String(err) };
				}

				const verificationId = verificationDoc.$odb?.key ?? null;

				if (emailResult?.ok) {
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
				verificationDoc.status = 'email_failed';
				verificationDoc.error = errorMessage;
				verificationDoc.sentAt = null;
				verificationDoc.emailMessageId = null;
				await verificationDoc.$odb.flush();
				return { error: 'email_failed', details: errorMessage };
			} catch (err) {
				console.error('auth/CreateVerifyEmail error:', err);
				return { error: 'internal_error' };
			} finally {
				await disposeDoc(verificationDoc);
				await disposeDoc(userDoc);
			}
		},
	};
};
