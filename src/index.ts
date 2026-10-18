// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";
import {
	fetchOrigin,
	getUrlParams,
	isSigValid,
	secureResponse,
} from "./helpers.ts";
import { fetchPreview } from "./preview.ts";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx?: ExecutionContext,
	): Promise<Response> {
		if (!["GET", "HEAD"].includes(request.method)) {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: { allow: "GET, HEAD", "cache-control": "no-store" },
			});
		}

		const url = new URL(request.url);
		const params = getUrlParams(url);
		if (!params || !(await isSigValid(env, params.sig, params.origUrlBase64))) {
			return new Response("Forbidden", {
				status: 403,
				headers: { "cache-control": "no-store" },
			});
		}

		let origin: URL;
		try {
			origin = new URL(
				Buffer.from(params.origUrlBase64, "base64url").toString("utf8"),
			);
			if (
				!["http:", "https:"].includes(origin.protocol) ||
				origin.username ||
				origin.password
			)
				throw new Error("Invalid media URL");
		} catch {
			return new Response("Forbidden", {
				status: 403,
				headers: { "cache-control": "no-store" },
			});
		}

		const path = origin.pathname.replace(/\/+$/, "");
		const filename = path.slice(path.lastIndexOf("/") + 1);
		if (params.filename && filename) {
			let matches =
				params.filename === filename || encodeURI(params.filename) === filename;
			try {
				matches ||= decodeURIComponent(params.filename) === filename;
			} catch {
				// Malformed percent encoding is not an alternative spelling of the filename.
			}
			if (!matches) {
				// Match Pleroma's media proxy controller, which also drops the query
				// string when canonicalizing a wrong filename.
				url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}${filename}`;
				url.search = "";
				return secureResponse(
					Response.redirect(url.href, 302),
					"public, max-age=300",
				);
			}
		}

		// On a Cloudflare route, a same-URL subrequest goes to the Pleroma origin.
		// Keep redirects visible so preview and filename canonicalization retain their semantics.
		const pleromaRequest = new Request(request, { redirect: "manual" });
		if (params.isPreview) {
			let mode: string = env.PREVIEW_MODE ?? "worker";
			if (mode === "worker") {
				try {
					return await fetchPreview(env, origin, request, ctx);
				} catch {
					if (request.signal.aborted) throw request.signal.reason;
					mode = env.PREVIEW_FALLBACK ?? "pleroma";
				}
			}
			if (mode === "pleroma")
				// Pleroma responses keep their own cache policy.
				return secureResponse(await fetch(pleromaRequest), null);
			if (mode === "original") {
				try {
					return await fetchOrigin(env, origin, request, filename);
				} catch {
					if (request.signal.aborted) throw request.signal.reason;
				}
			}
			return new Response(
				request.method === "HEAD" ? null : "Media preview unavailable",
				{
					status: 502,
					headers: { "cache-control": "no-store" },
				},
			);
		}
		if (origin.host === url.host) {
			return secureResponse(await fetch(pleromaRequest));
		}

		try {
			return await fetchOrigin(env, origin, request, filename);
		} catch {
			if (request.signal.aborted) throw request.signal.reason;
			if ((env.MEDIA_FALLBACK ?? "pleroma") === "pleroma") {
				console.warn("Direct media fetch failed; falling back to Pleroma");
				// Pleroma responses keep their own cache policy.
				return secureResponse(await fetch(pleromaRequest), null);
			}
			return new Response(
				request.method === "HEAD" ? null : "Media unavailable",
				{
					status: 502,
					headers: { "cache-control": "no-store" },
				},
			);
		}
	},
};
