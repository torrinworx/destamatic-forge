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

export default ({ serverProps, config }) => {
	const route = ensureRoute(config.route ?? defaults.route);
	const filesPath = typeof config.filesPath === "string" && config.filesPath ? config.filesPath : defaults.filesPath;
	const allowInProduction = config.allowInProduction === true;
	const staticOptions = {
		...defaults.staticOptions,
		...(config.staticOptions || {}),
	};

	const notFoundPayload = {
		...defaults.notFound.payload,
		...(config.notFound?.payload || {}),
	};
	const notFoundStatus = typeof config.notFound?.status === "number" && Number.isFinite(config.notFound.status)
		? Math.max(100, Math.min(599, Math.floor(config.notFound.status)))
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
