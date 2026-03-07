import { OObject } from 'destam';

export const deps = ['email/Smtp', 'email/Resend'];

export const defaults = {
	provider: 'smtp',
	from: 'no-reply@example.com',
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const ensureTrimmedString = (value) => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
};
const ensureHtmlString = (value) => (typeof value === 'string' && value.trim() ? value : null);
const toErrorMessage = (err) => {
	if (typeof err === 'string' && err) return err;
	if (err && typeof err.message === 'string' && err.message) return err.message;
	return err ? String(err) : 'Unknown error';
};
const disposeDoc = async (doc) => {
	if (doc?.$odb?.dispose) {
		try {
			await doc.$odb.dispose();
		} catch (err) {
			console.error('email/Create dispose error:', err);
		}
	}
};

const buildConfig = (webCore) => {
	const overrides = isPlainObject(webCore.config) ? webCore.config : {};
	const provider = ensureTrimmedString(overrides.provider) ?? defaults.provider;
	const from = ensureTrimmedString(overrides.from) ?? defaults.from;

	return { provider, from };
};

export default (injection = {}) => {
	const { odb, webCore, Smtp, Resend } = injection;

	const cfg = buildConfig(webCore);
	const providerMap = {
		smtp: Smtp,
		resend: Resend,
	};
	const resolvedProvider = providerMap[cfg.provider] ? cfg.provider : 'smtp';
	const provider = providerMap[resolvedProvider];

	return {
		internal: async ({ html, userId, subject }) => {
			if (typeof provider !== 'function') return { error: 'invalid_provider' };

			const htmlContent = ensureHtmlString(html);
			if (!htmlContent) return { error: 'invalid_html' };

			const cleanSubject = ensureTrimmedString(subject);
			if (!cleanSubject) return { error: 'invalid_subject' };

			const cleanUserId = ensureTrimmedString(userId);
			if (!cleanUserId) return { error: 'invalid_user' };

			const userDoc = await odb.findOne({
				collection: 'users',
				query: { filter: { field: 'id', op: 'eq', value: cleanUserId } },
			});
			if (!userDoc) return { error: 'user_not_found' };

			const recipientEmail = ensureTrimmedString(userDoc.email);
			if (!recipientEmail) {
				await disposeDoc(userDoc);
				return { error: 'user_missing_email' };
			}

			const now = Date.now();
			let emailDoc = null;

			try {
				emailDoc = await odb.open({
					collection: 'emails',
					value: OObject({
						userId: cleanUserId,
						recipientEmail,
						from: cfg.from,
						subject: cleanSubject,
						html: htmlContent,
						status: 'pending',
						createdAt: now,
						sentAt: null,
						messageId: null,
						error: null,
					}),
				});

				try {
					const sendResult = await provider({
						from: cfg.from,
						to: recipientEmail,
						subject: cleanSubject,
						html: htmlContent,
					});
					const messageId = ensureTrimmedString(sendResult?.messageId) ?? null;

					emailDoc.status = 'sent';
					emailDoc.sentAt = Date.now();
					emailDoc.messageId = messageId;
					emailDoc.error = null;
					await emailDoc.$odb.flush();

					return { ok: true, messageId };
				} catch (err) {
					const message = toErrorMessage(err);
					emailDoc.status = 'failed';
					emailDoc.sentAt = null;
					emailDoc.messageId = null;
					emailDoc.error = message;
					await emailDoc.$odb.flush();

					return { error: 'send_failed', details: message };
				}
			} finally {
				await disposeDoc(emailDoc);
				await disposeDoc(userDoc);
			}
		},
	};
};
