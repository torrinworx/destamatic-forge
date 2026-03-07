import { Resend } from 'resend';

export const defaults = {
	apiKey: null,
};

export default ({ webCore } = {}) => {
	const apiKey = typeof webCore.config.apiKey === 'string'
		? webCore.config.apiKey.trim()
		: '';

	if (!apiKey) throw new Error('Resend api key not provided.');

	const client = new Resend(apiKey);


	return {
		internal: async ({ from, to, subject, html }) => {
			const { data, error } = await client.emails.send({ from, to, subject, html });
			if (error) throw new Error(error?.message || 'email/Create Resend provider failed.');

			const messageId = typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : null;
			return { messageId };
		},
	};
};
