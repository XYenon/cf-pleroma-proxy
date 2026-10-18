// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";
import { fetchOrigin, secureResponse } from "./helpers.ts";

function acceptedQuality(accept: string, format: string): number {
	let quality = 0;
	let specificity = -1;
	for (const entry of accept.toLowerCase().split(",")) {
		const [type, ...parameters] = entry.split(";").map((part) => part.trim());
		const match = ["*/*", "image/*", format].indexOf(type);
		// A wildcard does not establish support for modern image codecs.
		if (match < 2 && ["image/avif", "image/webp"].includes(format)) continue;
		if (match < 0 || match < specificity) continue;
		const q = Number(
			parameters.find((part) => part.startsWith("q="))?.slice(2) ?? 1,
		);
		const weight = Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0;
		quality = match === specificity ? Math.max(quality, weight) : weight;
		specificity = match;
	}
	return quality;
}

// A generated preview depends on how Accept ranks the output formats, not on the
// header text itself. Keying on that ranking bounds the number of cache variants,
// so cosmetic q-value differences reuse one transformation.
const PREVIEW_FORMATS = ["image/avif", "image/webp", "image/png", "image/jpeg"];

function acceptVariant(accept: string): string {
	const groups = new Map<number, string[]>();
	for (const format of PREVIEW_FORMATS) {
		const quality = acceptedQuality(accept, format);
		const group = groups.get(quality);
		if (group) group.push(format);
		else groups.set(quality, [format]);
	}
	return [...groups]
		.sort(([left], [right]) => right - left)
		.map(([, formats]) => formats.join("+"))
		.join("|");
}

function previewResponse(response: Response, request: Request): Response {
	const etag = response.headers.get("etag");
	const matches = request.headers
		.get("if-none-match")
		?.split(",")
		.some((value) => {
			const tag = value.trim();
			return tag === "*" || tag.replace(/^W\//, "") === etag;
		});
	if (matches || request.method === "HEAD") {
		void response.body?.cancel().catch(() => {});
		return new Response(null, {
			status: matches ? 304 : response.status,
			headers: response.headers,
		});
	}
	return response;
}

export async function fetchPreview(
	env: Env,
	origin: URL,
	request: Request,
	ctx?: ExecutionContext,
): Promise<Response> {
	const accept = request.headers.get("accept") || "*/*";
	const url = new URL(request.url);
	const isStatic = url.searchParams.get("static") === "true";
	// Cache API does not select variants using Vary: Accept. Include the negotiated
	// format ranking in the key explicitly, and version the key when changing the
	// transformation recipe.
	url.search = "";
	url.searchParams.set("__preview", "2");
	url.searchParams.set("accept", acceptVariant(accept));
	url.searchParams.set("static", String(isStatic));
	const key = new Request(url, { method: "GET" });
	const cache = typeof caches === "undefined" ? undefined : caches.default;
	const cached = await cache?.match(key).catch(() => undefined);
	if (cached) return previewResponse(cached, request);

	// Source validators and ranges refer to the original, not the generated preview.
	const sourceRequest = new Request(request.url, {
		method: "GET",
		signal: request.signal,
	});
	const source = await fetchOrigin(env, origin, sourceRequest);
	let result: Response | undefined;
	try {
		if (source.status !== 200 || !source.body)
			throw new Error("Preview source unavailable");
		// biome-ignore lint/style/noNonNullAssertion: fetchOrigin sets Content-Type on every successful media response.
		const type = source.headers.get("content-type")!;
		const formats = [
			"image/avif",
			"image/webp",
			...(type === "image/png" || type === "image/gif"
				? ["image/png", "image/jpeg"]
				: ["image/jpeg", "image/png"]),
		];
		formats.sort(
			(a, b) => acceptedQuality(accept, b) - acceptedQuality(accept, a),
		);
		const format = formats[0] as ImageOutputOptions["format"];
		if (!acceptedQuality(accept, format))
			throw new Error("No acceptable preview format");
		const dimensions = { width: 600, height: 600, fit: "scale-down" as const };
		if (type.startsWith("video/")) {
			if (!env.MEDIA) throw new Error("Missing MEDIA binding");
			result = await env.MEDIA.input(source.body)
				.transform(dimensions)
				// Use a lossless intermediate when Images will encode the frame again.
				.output({
					mode: "frame",
					time: "0s",
					format: format === "image/jpeg" ? "jpg" : "png",
				})
				.response();
			if (!result.ok || !result.body) throw new Error("Video preview failed");
			if (format === "image/avif" || format === "image/webp") {
				if (!env.IMAGES) throw new Error("Missing IMAGES binding");
				result = (
					await env.IMAGES.input(result.body).output({
						format,
						quality: 85,
						anim: false,
					})
				).response();
			}
		} else if (type.startsWith("image/") && type !== "image/svg+xml") {
			if (!env.IMAGES) throw new Error("Missing IMAGES binding");
			// Images rejects anim:true for output formats that cannot preserve animation.
			result = (
				await env.IMAGES.input(source.body)
					.transform(dimensions)
					.output({
						format,
						quality: 85,
						anim: !isStatic && format === "image/webp",
					})
			).response();
		} else {
			throw new Error("Unsupported preview media");
		}
		const outputType = result.headers.get("content-type")?.split(";")[0];
		if (
			!result.ok ||
			!outputType ||
			!formats.includes(outputType) ||
			!acceptedQuality(accept, outputType)
		) {
			throw new Error("Unsupported preview output");
		}
		// Finish generated output before committing headers so encoding/read errors
		// can use the configured fallback. See https://github.com/cloudflare/workerd/issues/6818.
		const bytes = await result.arrayBuffer();
		if (!bytes.byteLength) throw new Error("Empty preview output");
		const hash = Buffer.from(
			await crypto.subtle.digest("SHA-256", bytes),
		).toString("hex");
		const extension =
			outputType === "image/jpeg" ? "jpg" : outputType.slice("image/".length);
		const response = secureResponse(
			new Response(bytes, {
				headers: {
					"content-type": outputType,
					"content-length": String(bytes.byteLength),
					"content-disposition": `inline; filename="preview.${extension}"`,
					vary: "Accept",
					etag: `"${hash}"`,
				},
			}),
		);
		if (cache) {
			const storing = cache.put(key, response.clone()).catch(() => {});
			if (ctx) ctx.waitUntil(storing);
			else await storing;
		}
		return previewResponse(response, request);
	} finally {
		for (const body of [source.body, result?.body]) {
			if (body && !body.locked) void body.cancel().catch(() => {});
		}
	}
}
