import fs from 'fs/promises';
import path from 'path';
import UUID from 'destam/UUID.js';
import { OObject } from 'destam';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const ensureDir = async dir => {
	await fs.mkdir(dir, { recursive: true });
};

export default ({ odb }) => {
	const s3 = new S3Client({
		region: process.env.SPACES_REGION,
		endpoint: process.env.SPACES_ENDPOINT,
		credentials: {
			accessKeyId: process.env.SPACES_KEY,
			secretAccessKey: process.env.SPACES_SECRET,
		},
	});

	return {
		async int({ userId, file, originalName, mimeType, meta }) {
			const isProd = process.env.NODE_ENV === 'production';

			let buffer;
			let size;
			let inferredOriginal = originalName;
			let inferredMime = mimeType;

			if (file && (file.buffer || file.stream || file.path)) {
				if (file.buffer) {
					buffer = file.buffer;
				} else if (file.path) {
					buffer = await fs.readFile(file.path);
				} else {
					throw new Error('Unsupported file input: stream not handled (pass a Buffer)');
				}

				size = file.size ?? buffer.byteLength;
				inferredOriginal ??= file.originalname;
				inferredMime ??= file.mimetype;
			} else {
				buffer = file;
				size = buffer?.byteLength;
			}

			if (!buffer || typeof size !== 'number') {
				throw new Error('No file data provided (expected Buffer/Uint8Array or multer file object)');
			}

			const fileUUID = UUID();
			const fileId = fileUUID.toHex();
			const fileIdRaw = fileUUID.rawHex();

			let storage;
			if (isProd) {
				const bucket = process.env.SPACES_BUCKET;
				if (!bucket) throw new Error('SPACES_BUCKET env var is not set');

				await s3.send(
					new PutObjectCommand({
						Bucket: bucket,
						Key: fileIdRaw,
						Body: buffer,
						ContentType: inferredMime || 'application/octet-stream',
						ACL: 'public-read',
					})
				);

				storage = {
					provider: 'spaces',
					bucket,
					fileId,
					endpoint: process.env.SPACES_ENDPOINT,
				};
			} else {
				const filesPath = process.env.FILES_PATH;

				if (filesPath) {
					await ensureDir(filesPath);
					const absPath = path.resolve(filesPath, fileIdRaw);
					await fs.writeFile(absPath, buffer);

					storage = {
						provider: 'fs',
						root: filesPath,
						fileId,
						path: absPath,
					};
				} else {
					storage = {
						provider: 'none',
						reason: 'FILES_PATH not set; skipping dev write',
					};
				}
			}

			const uploadedAt = Date.now();

			const doc = await odb.open({
				collection: 'files',
				query: { filter: { field: 'fileId', op: 'eq', value: fileId } },
				value: OObject({
					fileId,
					userId,
					uploadedAt,
					uploadedAtIso: new Date(uploadedAt).toISOString(),
					originalName: inferredOriginal || null,
					mimeType: inferredMime || null,
					size,
					storage,
					meta,
				}),
			});

			await doc.$odb.flush();
			return fileId;
		},
	};
};
