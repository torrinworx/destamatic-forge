import nodemailer from 'nodemailer';

export const defaults = {
	transport: {
		host: 'localhost',
		port: 587,
		secure: false,
		auth: {
			user: null,
			pass: null,
		},
	},
};

export default ({ config } = {}) => {
	const transporterPromise = Promise.resolve(nodemailer.createTransport(config.transport));

	return {
		internal: async ({ from, to, subject, html }) => {
			const transporter = await transporterPromise;
			const sendResult = await transporter.sendMail({ from, to, subject, html });
			const messageId = typeof sendResult?.messageId === 'string' && sendResult.messageId.trim()
				? sendResult.messageId.trim()
				: null;
			return { messageId };
		},
	};
};
