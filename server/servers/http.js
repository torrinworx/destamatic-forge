import fs from 'fs';
import http from 'http';
import path from 'path';

const mimeTypes = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.xml': 'application/xml',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain',
};

export default () => {
	let root;
	let vite;
	let server;

	return {
		production: ({ root: rootPath }) => {
			root = rootPath;

			server = http.createServer((req, res) => {
				const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
				let filePath = path.join(root, parsedUrl.pathname);

				fs.stat(filePath, (err, stats) => {
					if (!err && stats.isFile()) {
						// Serve static file
						const extname = path.extname(filePath);
						const contentType = mimeTypes[extname] || 'application/octet-stream';
						fs.readFile(filePath, (err, content) => {
							if (err) {
								res.writeHead(500);
								res.end(`Error: ${err.code} ..\n`);
								console.error('Error serving the file:', err);
							} else {
								res.writeHead(200, { 'Content-Type': contentType });
								res.end(content, 'utf-8');
							}
						});
					} else {
						// Fallback to index.html for client-side routing
						fs.readFile(path.join(root, 'index.html'), (err, content) => {
							if (err) {
								res.writeHead(500);
								res.end(`Error: ${err.code} ..\n`);
								console.error('Error serving index.html:', err);
							} else {
								res.writeHead(200, { 'Content-Type': 'text/html' });
								res.end(content, 'utf-8');
							}
						});
					}
				});
			});
		},
		development: ({ vite: viteInstance }) => {
			vite = viteInstance;
			server = http.createServer((req, res) => {
				vite.middlewares(req, res, (err) => {
					if (err) {
						res.writeHead(500);
						res.end(`Error: ${err.message} ..\n`);
						vite.ssrFixStacktrace(err);
						console.error('Error during Vite middlewares:', err);
					}
				})
			});
		},
		listen: (port) => {
			const listenPort = port == null ? 3000 : port;
			return server.listen(listenPort, () => {
				const actualPort = typeof server.address === 'function'
					? server.address()?.port
					: listenPort;
				console.log(`destamatic-forge running on http://localhost:${actualPort}/ using http server.`);
			});
		}
	}
};
