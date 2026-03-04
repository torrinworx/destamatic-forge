import multer from 'multer';
import cookieParser from 'cookie-parser';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const formatMessage = (message, detail) => {
	if (typeof message === 'function') return message(detail);
	if (!message) return detail ?? '';
	if (detail == null || detail === '') return message;
	return `${message}: ${detail}`;
};

export const deps = ['files/Create', 'moderation/images'];

export const defaults = {
	route: '/api/upload',
	fieldName: 'file',
	maxBytes: 10 * 1024 * 1024, // 10MB
	allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
	cookieName: 'webcore',
	sessionCollection: 'sessions',
	messages: {
		noFile: 'No file',
		unsupportedMime: 'Unsupported file type',
		emptyFile: 'Empty file',
		missingToken: 'Missing session token',
		invalidSession: 'Invalid session',
		sessionDisabled: 'Session disabled',
		sessionExpired: 'Session expired',
		noUser: 'Session has no user',
		moderationFailed: 'Image failed moderation',
		moderationReason: 'Moderation failed',
		internalError: 'Internal error',
	},
};

export default ({ serverProps, Create: addFile, images: modImg, odb, webCore }) => {
	const app = serverProps.app;
	app.use(cookieParser());

	const cfg = webCore?.config ?? {};

	const route = typeof cfg.route === 'string' && cfg.route ? cfg.route : defaults.route;
	const fieldName = typeof cfg.fieldName === 'string' && cfg.fieldName ? cfg.fieldName : defaults.fieldName;
	const userMaxBytes = Number.isFinite(cfg.maxBytes) ? Math.floor(cfg.maxBytes) : null;
	const maxBytes = userMaxBytes && userMaxBytes > 0 ? userMaxBytes : defaults.maxBytes;
	const allowedMimeTypes = Array.isArray(cfg.allowedMimeTypes) ? cfg.allowedMimeTypes : defaults.allowedMimeTypes;
	const allowedMimes = new Set(allowedMimeTypes);
	const cookieName = typeof cfg.cookieName === 'string' && cfg.cookieName ? cfg.cookieName : defaults.cookieName;
	const sessionCollection = typeof cfg.sessionCollection === 'string' && cfg.sessionCollection ? cfg.sessionCollection : defaults.sessionCollection;
	const messageOverrides = isPlainObject(cfg.messages) ? { ...defaults.messages, ...cfg.messages } : defaults.messages;

	const upload = multer({
		storage: multer.memoryStorage(),
		limits: { fileSize: maxBytes },
	});

	app.post(route, upload.single(fieldName), async (req, res) => {
		try {
			if (!req.file) return res.status(400).json({ ok: false, error: messageOverrides.noFile });

			// Basic file checks early
			const { mimetype, size, buffer, originalname } = req.file;

			if (!allowedMimes.has(mimetype)) {
				return res.status(400).json({
					ok: false,
					error: formatMessage(messageOverrides.unsupportedMime, mimetype),
				});
			}

			if (!buffer || !buffer.length) {
				return res.status(400).json({ ok: false, error: messageOverrides.emptyFile });
			}

			// Auth/session checks
			const token = req.cookies?.[cookieName];
			if (!token) return res.status(401).json({ ok: false, error: messageOverrides.missingToken });

			const session = await odb.findOne({ collection: sessionCollection, query: { uuid: token } });
			if (!session) return res.status(401).json({ ok: false, error: messageOverrides.invalidSession });

			const now = Date.now();
			if (!session.status) {
				return res.status(401).json({ ok: false, error: messageOverrides.sessionDisabled });
			}
			if (typeof session.expires !== 'number' || session.expires <= now) {
				return res.status(401).json({ ok: false, error: messageOverrides.sessionExpired });
			}

			const user = session.user;
			if (!user) return res.status(401).json({ ok: false, error: messageOverrides.noUser });

			const base64 = buffer.toString('base64');

			const normalizedMime = mimetype === 'image/jpg' ? 'image/jpeg' : mimetype;
			const mod = await modImg({
				imageBase64: base64,
				mimeType: normalizedMime,
			});

			if (!mod?.ok) {
				return res.status(400).json({
					ok: false,
					error: formatMessage(messageOverrides.moderationFailed, mod?.reason || messageOverrides.moderationReason),
					reason: mod?.reason || messageOverrides.moderationReason,
				});
			}

			const fileId = await addFile({
				user,
				file: req.file,
				meta: {
					ip: req.ip,
					originalname,
					mimetype,
					size,
					moderation: {
						passed: true,
						reason: mod.reason,
						categories: mod.categories,
						scores: mod.scores,
					},
				},
			});

			return res.json(fileId);
		} catch (err) {
			console.error('upload error:', err);
			return res.status(500).json({ ok: false, error: messageOverrides.internalError });
		}
	});
};
