// SPDX-License-Identifier: AGPL-3.0-or-later

import { Buffer } from "node:buffer";

const INLINE_CONTENT_TYPES = [
	"image/apng",
	"image/avif",
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/svg+xml",
	"image/webp",
	"audio/mpeg",
	"audio/mp3",
	"video/webm",
	"video/mp4",
	"video/quicktime",
];
let signingKey: { secret: string; key: Promise<CryptoKey> } | undefined;

export function getUrlParams(url: URL) {
	const match =
		/^\/proxy\/(preview\/)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/.exec(
			url.pathname,
		);
	if (!match) return null;
	return {
		isPreview: !!match[1],
		sig: match[2],
		origUrlBase64: match[3],
		filename: match[4],
	};
}

export async function isSigValid(
	env: Env,
	sig: string,
	origUrlBase64: string,
): Promise<boolean> {
	if (!signingKey || signingKey.secret !== env.SECRET_KEY_BASE) {
		signingKey = {
			secret: env.SECRET_KEY_BASE,
			key: crypto.subtle.importKey(
				"raw",
				Buffer.from(env.SECRET_KEY_BASE),
				{ name: "HMAC", hash: "SHA-1" },
				false,
				["verify"],
			),
		};
	}
	return crypto.subtle.verify(
		"HMAC",
		await signingKey.key,
		Buffer.from(sig, "base64url"),
		Buffer.from(origUrlBase64),
	);
}

function proxyHeaders(request: Request, env: Env): Headers {
	const headers = new Headers();
	for (const name of [
		"accept",
		"cache-control",
		"if-modified-since",
		"if-unmodified-since",
		"if-none-match",
		"range",
		"if-range",
	]) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	// Keep byte counts and ranges independent of automatic decompression.
	headers.set("accept-encoding", "identity");
	headers.set("user-agent", env.USER_AGENT);
	return headers;
}

// undefined applies the media default when the response has none, null keeps the
// response's own policy (including none, as Pleroma's redirects and errors do),
// and a string overrides it.
export function secureResponse(
	response: Response,
	cacheControl?: string | null,
): Response {
	const headers = new Headers(response.headers);
	headers.set("content-security-policy", "sandbox;");
	const upstream = headers.get("cache-control");
	const directives =
		cacheControl === null
			? upstream
			: (cacheControl ?? upstream ?? "public, max-age=1209600, immutable");
	if (directives !== null) {
		const transformed = directives
			.split(",")
			.some((value) => value.trim().toLowerCase() === "no-transform");
		headers.set(
			"cache-control",
			transformed ? directives : `${directives}, no-transform`,
		);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function fetchOrigin(
	env: Env,
	url: URL,
	request: Request,
	filename?: string,
): Promise<Response> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
	let finished = false;
	const finish = () => {
		finished = true;
		request.signal.removeEventListener("abort", cancelRequest);
	};
	const fail = (error: unknown) => {
		if (finished) return;
		finish();
		void reader?.cancel(error).catch(() => {});
		// Once headers are sent, error the stream instead of completing a partial file.
		downstream?.error(error);
	};
	const cancelRequest = () => fail(request.signal.reason);
	request.signal.addEventListener("abort", cancelRequest, { once: true });
	if (request.signal.aborted) cancelRequest();

	try {
		const response = await fetch(url, {
			method: request.method,
			headers: proxyHeaders(request, env),
			redirect: "follow",
			signal: request.signal,
		});
		const sourceReader = response.body?.getReader();
		reader = sourceReader;
		request.signal.throwIfAborted();
		if (![200, 206, 304].includes(response.status))
			throw new Error(`Media HTTP ${response.status}`);
		if (
			response.status !== 304 &&
			response.headers.has("content-encoding") &&
			response.headers.get("content-encoding") !== "identity"
		) {
			throw new Error("Origin ignored identity encoding");
		}

		const lengthHeader = response.headers.get("content-length");
		let length: number | undefined;
		if (lengthHeader !== null) {
			// Fetch combines duplicate headers with commas. Accept identical values only.
			const lengths = lengthHeader.split(",").map((value) => value.trim());
			if (lengths.some((value) => !/^\d+$/.test(value)))
				throw new Error("Invalid media Content-Length");
			length = Number(lengths[0]);
			if (
				!Number.isSafeInteger(length) ||
				lengths.some((value) => Number(value) !== length)
			) {
				throw new Error("Conflicting media Content-Length");
			}
		}

		const headers = new Headers();
		for (const name of [
			"etag",
			"date",
			"last-modified",
			"content-disposition",
			"content-range",
			"accept-ranges",
			"vary",
		]) {
			const value = response.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		const rawType = (
			response.headers.get("content-type") || "application/octet-stream"
		).split(";")[0];
		const safeType = ["image", "audio", "video"].includes(rawType.split("/")[0])
			? rawType
			: "application/octet-stream";
		headers.set("content-type", safeType);
		if (!INLINE_CONTENT_TYPES.includes(safeType)) {
			const upstreamName = /filename="((?:[^"\\]|\\.)*)"/.exec(
				headers.get("content-disposition") || "",
			)?.[1];
			const name =
				upstreamName ?? (filename || "attachment").replace(/["\\]/g, "\\$&");
			headers.set("content-disposition", `attachment; filename="${name}"`);
		}
		if (length !== undefined) headers.set("content-length", String(length));
		if (request.method === "HEAD" || response.status === 304 || !sourceReader) {
			if (request.method !== "HEAD" && response.status !== 304 && length)
				throw new Error("Incomplete media body");
			finish();
			void reader?.cancel().catch(() => {});
			return secureResponse(
				new Response(null, { status: response.status, headers }),
			);
		}

		if (length === undefined) {
			// Stream without unbounded buffering. Errors may appear as clean chunked EOF
			// until https://github.com/cloudflare/workerd/issues/6818 is fixed.
			finish();
			sourceReader.releaseLock();
			return secureResponse(
				new Response(response.body, { status: response.status, headers }),
			);
		}

		let size = 0;
		let tail: Uint8Array | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				downstream = controller;
			},
			async pull(controller) {
				try {
					while (true) {
						const { done, value } = await sourceReader.read();
						if (finished) return;
						if (done) {
							if (size !== length) throw new Error("Incomplete media body");
							finish();
							if (tail) controller.enqueue(tail);
							controller.close();
							return;
						}
						size += value.byteLength;
						if (size > length) throw new Error("Media Content-Length exceeded");
						if (!value.byteLength) continue;
						// Withhold the final byte until EOF, even if the advertised length was reached.
						const emitted = !!tail || value.byteLength > 1;
						if (tail) controller.enqueue(tail);
						if (value.byteLength > 1) controller.enqueue(value.subarray(0, -1));
						tail = value.subarray(-1);
						if (emitted) return;
					}
				} catch (error) {
					fail(error);
				}
			},
			cancel(reason) {
				finish();
				return sourceReader.cancel(reason);
			},
		});
		// A native fixed-length body preserves Content-Length on the wire, so clients
		// detect truncation even on runtimes that swallow chunked-stream errors.
		// https://github.com/cloudflare/workerd/issues/6818
		const fixed = new FixedLengthStream(length);
		void body.pipeTo(fixed.writable).catch(() => {});
		return secureResponse(
			new Response(fixed.readable, { status: response.status, headers }),
		);
	} catch (error) {
		if (!request.signal.aborted) fail(error);
		throw error;
	}
}
