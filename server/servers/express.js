import fs from "fs";
import path from "path";
import express from "express";

export default () => {
	const app = express();
	let root = null;
	let vite = null;

	// stuff modules can add before SPA fallback
	const pre = [];

	const use = (...args) => pre.push({ type: "use", args });
	const get = (...args) => pre.push({ type: "get", args });
	const post = (...args) => pre.push({ type: "post", args });

	const applyPre = () => {
		for (const item of pre) app[item.type](...item.args);
	};

	const mountSpaFallback = () => {
		// IMPORTANT: don't catch /api (or ws paths) in SPA fallback
		app.get(/^\/(?!api\/).*/, async (req, res, next) => {
			try {
				if (vite) {
					const html = await vite.transformIndexHtml(
						req.originalUrl,
						fs.readFileSync(path.resolve(root, "index.html"), "utf-8")
					);
					res.status(200).set({ "Content-Type": "text/html" }).end(html);
				} else {
					res.sendFile("index.html", { root });
				}
			} catch (e) {
				vite?.ssrFixStacktrace?.(e);
				next(e);
			}
		});
	};

	return {
		// expose these so modules can register endpoints
		props: { app },
		use,
		get,
		post,

		production: ({ root: rootPath }) => {
			root = rootPath;
			vite = null;
			// NOTE: do NOT mount fallback yet
		},

		development: ({ vite: viteInstance, root: rootPath }) => {
			root = rootPath;
			vite = viteInstance;
			// NOTE: do NOT mount fallback yet
		},

		listen: (port) => {
			const listenPort = port == null ? 3000 : port;
			// order: module routes first, then Vite/static, then fallback
			applyPre();

			if (vite) app.use(vite.middlewares);
			else app.use(express.static(root));

			mountSpaFallback();

			const nodeServer = app.listen(listenPort, () => {
				const actualPort = typeof nodeServer?.address === 'function'
					? nodeServer.address()?.port
					: listenPort;
				console.log(`Serving on http://localhost:${actualPort}/ (express)`);
			});
			return nodeServer;
		},
	};
};
