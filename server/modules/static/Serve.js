/*
A simple static asset server attachment to the express server.

Meant to just be a development shim, not meant for production use.
*/

import path from "path";
import express from "express";

export const defaults = {
	route: "/files",
	filesPath: null,
	allowInProduction: false,
	staticOptions: {
		fallthrough: false,
		index: false,
	},
	notFound: {
		status: 404,
		payload: {
			ok: false,
			error: "File not found",
		},
	},
};

const ensureRoute = (value) => {
	const candidate = typeof value === "string" ? value.trim() : "";
	if (!candidate) return defaults.route;
	return candidate.startsWith("/") ? candidate : `/${candidate}`;
};

export default ({ serverProps, webCore }) => {
	const cfg = webCore?.config || {};
	const route = ensureRoute(cfg.route ?? defaults.route);
	const filesPath = typeof cfg.filesPath === "string" && cfg.filesPath ? cfg.filesPath : defaults.filesPath;
	const allowInProduction = cfg.allowInProduction === true;
	const staticOptions = {
		...defaults.staticOptions,
		...(cfg.staticOptions || {}),
	};

	const notFoundPayload = {
		...defaults.notFound.payload,
		...(cfg.notFound?.payload || {}),
	};
	const notFoundStatus = typeof cfg.notFound?.status === "number" && Number.isFinite(cfg.notFound.status)
		? Math.max(100, Math.min(599, Math.floor(cfg.notFound.status)))
		: defaults.notFound.status;

	if (!allowInProduction && process.env.NODE_ENV === "production") return;
	if (!filesPath) return; // avoid crashing when env is unset

	const app = serverProps?.app;
	if (!app) return;

	app.use(route, express.static(path.resolve(filesPath), staticOptions));

	app.use(route, (req, res) => {
		res.status(notFoundStatus).json(notFoundPayload);
	});
};
