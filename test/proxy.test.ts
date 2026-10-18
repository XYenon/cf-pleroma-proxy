// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.ts";

// Node lacks this Workers primitive. Wire framing is also checked in workerd.
Object.defineProperty(globalThis, "FixedLengthStream", {
	value: class extends TransformStream<Uint8Array, Uint8Array> {
		constructor(length: number) {
			let written = 0;
			super({
				transform(chunk, controller) {
					written += chunk.byteLength;
					if (written > length) throw new Error("FixedLengthStream overflow");
					controller.enqueue(chunk);
				},
				flush() {
					if (written !== length)
						throw new Error("FixedLengthStream truncated");
				},
			});
		}
	},
});

const env: Env = {
	SECRET_KEY_BASE: "test-secret",
	USER_AGENT: "PleromaMediaProxy/test",
	PREVIEW_MODE: "pleroma",
};
let sequence = 0;

function signedUrl(
	origin = `https://media.example/${sequence++}/image.webp`,
	preview = false,
	filename?: string,
) {
	const encoded = Buffer.from(origin).toString("base64url");
	const sig = createHmac("sha1", env.SECRET_KEY_BASE)
		.update(encoded)
		.digest("base64url");
	return `https://proxy.example/proxy/${preview ? "preview/" : ""}${sig}/${encoded}${filename ? `/${filename}` : ""}`;
}

test("accepts independently signed URLs with optional filenames and GET/HEAD; rejects tampering and other methods", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			return new Response(request.method === "HEAD" ? null : "media", {
				headers: { "content-type": "image/webp", "content-length": "5" },
			});
		},
	);
	for (const method of ["GET", "HEAD"]) {
		for (const filename of [undefined, "image.webp"]) {
			const response = await worker.fetch(
				new Request(signedUrl(undefined, false, filename), { method }),
				env,
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-length"), "5");
			assert.equal(await response.text(), method === "HEAD" ? "" : "media");
		}
	}
	const url = signedUrl();
	const forbidden = await worker.fetch(
		new Request(url.replace("/proxy/", "/proxy/x")),
		env,
	);
	assert.equal(forbidden.status, 403);
	assert.equal(forbidden.headers.get("cache-control"), "no-store");
	assert.equal(
		(
			await worker.fetch(
				new Request("https://proxy.example/proxy/a/b/extra/path"),
				env,
			)
		).status,
		403,
	);
	for (const origin of [
		"not a URL",
		"file:///etc/passwd",
		"https://user:pass@media.example/image.webp",
	]) {
		assert.equal(
			(await worker.fetch(new Request(signedUrl(origin)), env)).status,
			403,
		);
	}
	const response = await worker.fetch(
		new Request(url, { method: "POST" }),
		env,
	);
	assert.equal(response.status, 405);
	assert.equal(response.headers.get("allow"), "GET, HEAD");
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("canonicalizes wrong filenames and accepts equivalent percent encoding", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response("media", { headers: { "content-type": "image/png" } }),
	);
	for (const preview of [false, true]) {
		const canonical = signedUrl(
			"https://media.example/a%20b.png",
			preview,
			"a%20b.png",
		);
		const response = await worker.fetch(
			new Request(
				`${canonical.replace("/a%20b.png", "/wrong.png")}?static=true`,
			),
			env,
		);
		assert.equal(response.status, 302);
		// Like Pleroma's media proxy controller, the redirect drops the query.
		assert.equal(response.headers.get("location"), canonical);
		assert.equal(
			response.headers.get("cache-control"),
			"public, max-age=300, no-transform",
		);
	}
	for (const filename of ["a%20b.png", "a%2520b.png"]) {
		const response = await worker.fetch(
			new Request(
				signedUrl("https://media.example/a%20b.png", false, filename),
			),
			env,
		);
		assert.equal(response.status, 200);
		await response.text();
	}
});

test("preserves byte ranges and conditional responses without leaking client credentials", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url.startsWith("https://proxy.example"))
				return new Response(null, { status: 502 });
			assert.equal(request.headers.get("cookie"), null);
			assert.equal(request.headers.get("authorization"), null);
			assert.equal(request.headers.get("referer"), null);
			assert.equal(request.headers.get("user-agent"), env.USER_AGENT);
			assert.equal(request.headers.get("accept-encoding"), "identity");
			if (request.headers.has("range")) {
				assert.equal(request.headers.get("range"), "bytes=2-4");
				assert.equal(request.headers.get("if-range"), '"v1"');
				return new Response("234", {
					status: 206,
					headers: {
						"content-type": "video/mp4",
						"content-range": "bytes 2-4/10",
						"accept-ranges": "bytes",
						"content-length": "3",
					},
				});
			}
			assert.equal(request.headers.get("if-none-match"), '"v1"');
			return new Response(null, {
				status: 304,
				headers: { etag: '"v1"', "content-encoding": "gzip" },
			});
		},
	);
	const range = await worker.fetch(
		new Request(signedUrl(), {
			headers: {
				range: "bytes=2-4",
				"if-range": '"v1"',
				cookie: "session=secret",
				authorization: "Bearer secret",
				referer: "https://private.example",
			},
		}),
		env,
	);
	assert.equal(range.status, 206);
	assert.equal(range.headers.get("content-range"), "bytes 2-4/10");
	assert.equal(range.headers.get("accept-ranges"), "bytes");
	assert.equal(await range.text(), "234");
	const conditional = await worker.fetch(
		new Request(signedUrl(), { headers: { "if-none-match": '"v1"' } }),
		env,
	);
	assert.equal(conditional.status, 304);
	assert.equal(conditional.headers.get("etag"), '"v1"');
	assert.equal(conditional.body, null);
});

test("sandboxes active content, filters response headers and forces downloads for unsafe MIME types", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response("<script>bad()</script>", {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"content-disposition": 'inline; filename="a\\"b.html"',
					"set-cookie": "session=remote; Path=/",
					"cache-control": "private",
					"x-remote-header": "untrusted",
				},
			}),
	);
	const response = await worker.fetch(
		new Request(signedUrl("https://media.example/document.html")),
		env,
	);
	assert.equal(
		response.headers.get("content-type"),
		"application/octet-stream",
	);
	assert.equal(
		response.headers.get("content-disposition"),
		'attachment; filename="a\\"b.html"',
	);
	assert.equal(response.headers.get("content-security-policy"), "sandbox;");
	assert.equal(
		response.headers.get("cache-control"),
		"public, max-age=1209600, immutable, no-transform",
	);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("x-remote-header"), null);
	assert.equal(await response.text(), "<script>bad()</script>");
});

test("supports develop inline image types while retaining upstream attachment choices", async (t) => {
	let type = "";
	let disposition = "";
	t.mock.method(globalThis, "fetch", async () => {
		const headers = new Headers({ "content-type": `${type}; parameter=value` });
		if (disposition) headers.set("content-disposition", disposition);
		return new Response("image", { headers });
	});
	for (type of ["image/apng", "image/avif", "image/bmp", "image/webp"]) {
		const response = await worker.fetch(new Request(signedUrl()), env);
		assert.equal(response.headers.get("content-type"), type);
		assert.equal(response.headers.get("content-disposition"), null);
		await response.text();
	}
	disposition = 'attachment; filename="original.webp"';
	const response = await worker.fetch(new Request(signedUrl()), env);
	assert.equal(response.headers.get("content-disposition"), disposition);
	await response.text();
});

test("delegates previews, including static and HEAD, to Pleroma and preserves redirects", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			assert.equal(request.url, url);
			assert.equal(request.redirect, "manual");
			return new Response(null, {
				status: 301,
				headers: {
					location: "https://proxy.example/proxy/original",
					"cache-control": "public, No-Transform",
				},
			});
		},
	);
	let url = "";
	for (const method of ["GET", "HEAD"]) {
		url = `${signedUrl("https://media.example/animation.gif", true)}?static=true`;
		const response = await worker.fetch(new Request(url, { method }), env);
		assert.equal(response.status, 301);
		assert.equal(
			response.headers.get("location"),
			"https://proxy.example/proxy/original",
		);
		assert.equal(response.headers.get("cache-control"), "public, No-Transform");
	}
});

test("falls back without reading error bodies and retries the origin on every request", async (t) => {
	t.mock.method(console, "warn", () => {});
	let cancelled = false;
	let direct = 0;
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url.startsWith("https://proxy.example")) {
				assert.equal(request.redirect, "manual");
				return new Response("pleroma fallback");
			}
			direct++;
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 503 },
			);
		},
	);
	const url = signedUrl();
	const first = await worker.fetch(new Request(url), env);
	assert.equal(await first.text(), "pleroma fallback");
	// The fallback keeps Pleroma's policy, including the absence of one.
	assert.equal(first.headers.get("cache-control"), null);
	assert.equal(cancelled, true);
	const second = await worker.fetch(new Request(url), env);
	assert.equal(await second.text(), "pleroma fallback");
	assert.equal(second.headers.get("cache-control"), null);
	assert.equal(direct, 2);
});

test("fallback responses keep Pleroma's cache policy instead of the media default", async (t) => {
	t.mock.method(console, "warn", () => {});
	let headers: Record<string, string> = {};
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url.startsWith("https://proxy.example"))
				return new Response("pleroma fallback", { headers });
			return new Response(null, { status: 503 });
		},
	);
	const cases: Array<[Record<string, string>, string | null]> = [
		[
			{ "cache-control": "public, max-age=60, no-transform" },
			"public, max-age=60, no-transform",
		],
		[
			{ "cache-control": "public, max-age=60" },
			"public, max-age=60, no-transform",
		],
		[{}, null],
	];
	for (const [policy, expected] of cases) {
		headers = policy;
		const response = await worker.fetch(new Request(signedUrl()), env);
		assert.equal(response.headers.get("cache-control"), expected);
		await response.text();
	}
});

test("non-preview failures obey the default and configured media fallback for GET and HEAD", async (t) => {
	t.mock.method(console, "warn", () => {});
	for (const fallback of [undefined, "pleroma", "error"] as const) {
		for (const failure of ["http", "network", "encoding", "length"]) {
			for (const method of ["GET", "HEAD"]) {
				const url = `${signedUrl()}?download=true`;
				let backendRequests = 0;
				t.mock.method(
					globalThis,
					"fetch",
					async (input: RequestInfo | URL, init?: RequestInit) => {
						const request = new Request(input, init);
						if (request.url.startsWith("https://proxy.example")) {
							backendRequests++;
							assert.equal(request.url, url);
							assert.equal(request.method, method);
							assert.equal(request.redirect, "manual");
							assert.equal(request.headers.get("range"), "bytes=2-4");
							return new Response(null, {
								status: 302,
								headers: { location: "https://media.example/fallback.webp" },
							});
						}
						if (failure === "network")
							throw new Error("Network failure with private URL");
						return new Response(null, {
							status: failure === "http" ? 503 : 200,
							headers:
								failure === "encoding"
									? { "content-encoding": "gzip" }
									: { "content-length": "3, 4" },
						});
					},
				);
				const response = await worker.fetch(
					new Request(url, { method, headers: { range: "bytes=2-4" } }),
					{ ...env, MEDIA_FALLBACK: fallback, PREVIEW_FALLBACK: "error" },
				);
				if (fallback === "error") {
					assert.equal(backendRequests, 0);
					assert.equal(response.status, 502);
					assert.equal(response.headers.get("cache-control"), "no-store");
					assert.equal(
						await response.text(),
						method === "HEAD" ? "" : "Media unavailable",
					);
					if (method === "HEAD") assert.equal(response.body, null);
				} else {
					assert.equal(backendRequests, 1);
					assert.equal(response.status, 302);
					assert.equal(
						response.headers.get("location"),
						"https://media.example/fallback.webp",
					);
					assert.equal(
						response.headers.get("content-security-policy"),
						"sandbox;",
					);
					assert.equal(response.headers.get("cache-control"), null);
				}
			}
		}
	}
});

test("validates Content-Length on GET and HEAD without imposing a body size limit", async (t) => {
	t.mock.method(console, "warn", () => {});
	let length = "";
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			if (request.url.startsWith("https://proxy.example"))
				return new Response(null, { status: 502 });
			return new Response(request.method === "HEAD" ? null : "abc", {
				headers: { "content-type": "image/webp", "content-length": length },
			});
		},
	);
	for (const method of ["GET", "HEAD"]) {
		for (length of ["3, 3", "003, 3", "3"]) {
			const response = await worker.fetch(
				new Request(signedUrl(), { method }),
				env,
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-length"), "3");
			await response.text();
		}
		for (length of ["3x", "-1", "3, 4", "9007199254740992"]) {
			const response = await worker.fetch(
				new Request(signedUrl(), { method }),
				env,
			);
			assert.equal(response.status, 502, `${method}: ${length}`);
		}
	}
	length = "104857600";
	const head = await worker.fetch(
		new Request(signedUrl(), { method: "HEAD" }),
		env,
	);
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("content-length"), "104857600");
});

test("streams beyond 25 MiB successfully, but errors on incorrect lengths and upstream read failure", async (t) => {
	for (const failure of ["none", "overflow", "truncated", "upstream"]) {
		let remaining =
			failure === "overflow"
				? 27_262_977
				: failure === "truncated"
					? 3
					: 27_262_976;
		t.mock.method(globalThis, "fetch", async () => {
			const headers = new Headers({ "content-type": "video/mp4" });
			headers.set("content-length", "27262976");
			if (failure === "truncated") headers.set("content-length", "4");
			return new Response(
				new ReadableStream({
					pull(controller) {
						if (!remaining) {
							if (failure === "upstream")
								controller.error(new Error("upstream disconnected"));
							else controller.close();
							return;
						}
						const size = Math.min(remaining, 1_048_576);
						remaining -= size;
						controller.enqueue(new Uint8Array(size).fill(7));
					},
				}),
				{ headers },
			);
		});
		const response = await worker.fetch(new Request(signedUrl()), env);
		if (failure === "none") {
			const bytes = new Uint8Array(await response.arrayBuffer());
			assert.equal(bytes.length, 27_262_976);
			assert.equal(bytes[bytes.length - 1], 7);
		} else {
			await assert.rejects(
				response.arrayBuffer(),
				/exceeded|Incomplete|disconnected/,
			);
		}
		t.mock.restoreAll();
	}
});

test("allows reads beyond 30 seconds and preserves downstream cancellation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let cancelled = 0;
	let source!: ReadableStreamDefaultController<Uint8Array>;
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						source = controller;
					},
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "content-type": "image/webp", "content-length": "1" } },
			),
	);
	const response = await worker.fetch(new Request(signedUrl()), env);
	const reading = response.text();
	t.mock.timers.tick(60_000);
	assert.equal(cancelled, 0);
	source.enqueue(new Uint8Array([65]));
	source.close();
	assert.equal(await reading, "A");
	const abort = new AbortController();
	const other = await worker.fetch(
		new Request(signedUrl(), { signal: abort.signal }),
		env,
	);
	const pending = other.text();
	abort.abort(new Error("client disconnected"));
	await assert.rejects(pending, /client disconnected/);
	assert.equal(cancelled, 1);
});

test("streams unknown-length bodies beyond 25 MiB and validates declared empty bodies", async (t) => {
	t.mock.method(console, "warn", () => {});
	let size = 0;
	let declared: string | undefined;
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (new Request(input, init).url.startsWith("https://proxy.example"))
				return new Response(null, { status: 502 });
			const headers = new Headers({ "content-type": "image/png" });
			if (declared !== undefined) headers.set("content-length", declared);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(size).fill(9));
						controller.close();
					},
				}),
				{ headers },
			);
		},
	);
	for (size of [0, 5, 26_214_401]) {
		const response = await worker.fetch(new Request(signedUrl()), env);
		assert.equal(response.status, 200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		assert.equal(bytes.length, size);
		if (size) assert.equal(bytes[size - 1], 9);
	}
	declared = "0";
	size = 0;
	assert.equal(
		await (await worker.fetch(new Request(signedUrl()), env)).text(),
		"",
	);
	size = 1;
	await assert.rejects(
		(await worker.fetch(new Request(signedUrl()), env)).text(),
		/exceeded/,
	);
});

// These fixtures model the service boundary. Native Images encoding is also
// validated separately in workerd; Media has no offline implementation.
function previewEnv(): Env {
	return {
		...env,
		PREVIEW_MODE: "worker",
		PREVIEW_FALLBACK: "error",
		IMAGES: {
			input(body: ReadableStream<Uint8Array>) {
				let dimensions = {};
				return {
					transform(value: ImageTransform) {
						dimensions = value;
						return this;
					},
					async output(options: ImageOutputOptions) {
						const source = await new Response(body).text();
						if (options.anim && options.format !== "image/webp")
							throw new Error("Animation requires WebP output");
						return {
							response: () =>
								Response.json(
									{ source, ...dimensions, ...options },
									{ headers: { "content-type": options.format } },
								),
						};
					},
				};
			},
		} as ImagesBinding,
		MEDIA: {
			input(body: ReadableStream<Uint8Array>) {
				let dimensions = {};
				return {
					transform(value: MediaTransformationInputOptions) {
						dimensions = value;
						return this;
					},
					output(options: MediaTransformationOutputOptions) {
						return {
							async response() {
								const source = await new Response(body).text();
								return Response.json(
									{ source, ...dimensions, ...options },
									{
										headers: {
											"content-type":
												options.format === "png" ? "image/png" : "image/jpeg",
										},
									},
								);
							},
						};
					},
				};
			},
		} as unknown as MediaBinding,
	};
}

test("original preview mode proxies unchanged media, ranges and HEAD without invoking transforms or Pleroma", async (t) => {
	const config = previewEnv();
	config.PREVIEW_MODE = "original";
	assert(config.IMAGES);
	t.mock.method(config.IMAGES, "input", () => {
		throw new Error("must not transform");
	});
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			assert.equal(request.url, "https://media.example/original.png");
			assert.equal(request.headers.get("range"), "bytes=0-2");
			return new Response(request.method === "HEAD" ? null : "raw", {
				status: 206,
				headers: {
					"content-type": "image/png",
					"content-length": "3",
					"content-range": "bytes 0-2/100",
				},
			});
		},
	);
	for (const method of ["GET", "HEAD"]) {
		const response = await worker.fetch(
			new Request(signedUrl("https://media.example/original.png", true), {
				method,
				headers: { range: "bytes=0-2" },
			}),
			config,
		);
		assert.equal(response.status, 206);
		assert.equal(await response.text(), method === "HEAD" ? "" : "raw");
	}
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			assert.equal(
				new Request(input, init).url,
				"https://media.example/original.png",
			);
			return new Response(null, { status: 503 });
		},
	);
	const failed = await worker.fetch(
		new Request(signedUrl("https://media.example/original.png", true)),
		config,
	);
	assert.equal(failed.status, 502);
	assert.equal(failed.headers.get("cache-control"), "no-store");
});

test("worker previews negotiate browser formats and quality, preserve animations unless static, and discard source validators", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			assert.equal(request.url, "https://media.example/animation.gif");
			assert.equal(request.method, "GET");
			for (const name of [
				"range",
				"if-range",
				"if-none-match",
				"if-modified-since",
				"cookie",
				"authorization",
				"referer",
			]) {
				assert.equal(request.headers.get(name), null);
			}
			return new Response("original", {
				headers: { "content-type": "image/gif", etag: '"source"' },
			});
		},
	);
	for (const [accept, expected] of [
		["image/avif,image/webp,image/*;q=0.8", "image/avif"],
		["image/avif;q=0.4,image/webp;q=0.9", "image/webp"],
		["image/avif;q=0,image/webp;q=0,*/*", "image/png"],
		["image/*", "image/png"],
		["image/png;q=0,image/*;q=0.7", "image/jpeg"],
		["IMAGE/WEBP;Q=1,image/png;q=0.5", "image/webp"],
	]) {
		for (const isStatic of [false, true]) {
			const url =
				signedUrl("https://media.example/animation.gif", true) +
				(isStatic ? "?static=true" : "");
			const response = await worker.fetch(
				new Request(url, {
					headers: { accept, range: "bytes=0-2", "if-none-match": '"source"' },
				}),
				previewEnv(),
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), expected);
			assert.equal(response.headers.get("vary"), "Accept");
			assert.equal(response.headers.get("content-security-policy"), "sandbox;");
			assert.notEqual(response.headers.get("etag"), '"source"');
			assert.deepEqual(await response.json(), {
				source: "original",
				width: 600,
				height: 600,
				fit: "scale-down",
				format: expected,
				quality: 85,
				anim: !isStatic && expected === "image/webp",
			});
		}
	}
});

test("video previews extract the first frame and encode it for the browser; legacy clients use JPEG without Images", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response("video bytes", { headers: { "content-type": "video/mp4" } }),
	);
	for (const accept of ["image/avif,image/webp", "image/webp", "*/*"]) {
		const config = previewEnv();
		if (accept === "*/*") delete config.IMAGES;
		const response = await worker.fetch(
			new Request(signedUrl("https://media.example/movie.mp4", true), {
				headers: { accept },
			}),
			config,
		);
		assert.equal(response.status, 200);
		const payload = (await response.json()) as Record<string, unknown>;
		const frame =
			accept === "*/*" ? payload : JSON.parse(payload.source as string);
		assert.deepEqual(frame, {
			source: "video bytes",
			width: 600,
			height: 600,
			fit: "scale-down",
			mode: "frame",
			time: "0s",
			format: accept === "*/*" ? "jpg" : "png",
		});
		assert.equal(
			response.headers.get("content-type"),
			accept.startsWith("image/avif")
				? "image/avif"
				: accept === "*/*"
					? "image/jpeg"
					: "image/webp",
		);
	}
});

test("preview failures obey all three policies for unsupported media, missing bindings and late encoding errors", async (t) => {
	for (const fallback of ["pleroma", "original", "error"] as const) {
		for (const failure of [
			"unsupported",
			"binding",
			"media-binding",
			"late",
			"unacceptable",
		]) {
			const config = previewEnv();
			config.PREVIEW_FALLBACK = fallback;
			if (failure === "binding") delete config.IMAGES;
			if (failure === "media-binding") delete config.MEDIA;
			if (failure === "late") {
				assert(config.IMAGES);
				t.mock.method(
					config.IMAGES,
					"input",
					() =>
						({
							transform() {
								return this;
							},
							async output() {
								return {
									response: () =>
										new Response(
											new ReadableStream({
												start(controller) {
													controller.error(
														new Error("encoder failed with private URL"),
													);
												},
											}),
											{ headers: { "content-type": "image/webp" } },
										),
								};
							},
						}) as unknown as ImageTransformer,
				);
			}
			t.mock.method(
				globalThis,
				"fetch",
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = new Request(input, init);
					if (request.url.startsWith("https://proxy.example")) {
						assert.equal(fallback, "pleroma");
						assert.equal(request.redirect, "manual");
						return new Response("pleroma preview");
					}
					return new Response("original bytes", {
						headers: {
							"content-type":
								failure === "unsupported"
									? "audio/mpeg"
									: failure === "media-binding"
										? "video/mp4"
										: "image/png",
						},
					});
				},
			);
			const response = await worker.fetch(
				new Request(signedUrl(undefined, true), {
					headers: {
						accept:
							failure === "unacceptable"
								? "image/avif;q=0,image/*;q=0,*/*;q=0"
								: "image/webp",
					},
				}),
				config,
			);
			assert.equal(
				response.status,
				fallback === "error" ? 502 : 200,
				`${fallback}/${failure}`,
			);
			assert.equal(
				await response.text(),
				fallback === "pleroma"
					? "pleroma preview"
					: fallback === "original"
						? "original bytes"
						: "Media preview unavailable",
			);
			if (fallback === "error")
				assert.equal(response.headers.get("cache-control"), "no-store");
			if (fallback === "pleroma")
				assert.equal(response.headers.get("cache-control"), null);
			t.mock.restoreAll();
		}
	}
});

test("preview cache separates browser and static variants, shares GET/HEAD and applies preview ETags", async (t) => {
	const entries = new Map<string, Response>();
	Object.defineProperty(globalThis, "caches", {
		configurable: true,
		value: {
			default: {
				async match(request: Request) {
					return entries.get(request.url)?.clone();
				},
				async put(request: Request, response: Response) {
					entries.set(request.url, response);
				},
			},
		},
	});
	t.after(() => {
		Reflect.deleteProperty(globalThis, "caches");
	});
	let reads = 0;
	t.mock.method(globalThis, "fetch", async () => {
		reads++;
		return new Response("image", { headers: { "content-type": "image/png" } });
	});
	const url = signedUrl(undefined, true);
	const config = previewEnv();
	const headers = { accept: "image/webp" };
	const response = await worker.fetch(new Request(url, { headers }), config);
	const etag = response.headers.get("etag");
	assert(etag);
	const content = await response.text();
	assert.match(etag, /^"[a-f0-9]{64}"$/);
	const head = await worker.fetch(
		new Request(url, { method: "HEAD", headers }),
		config,
	);
	assert.equal(await head.text(), "");
	assert.equal(
		head.headers.get("content-length"),
		String(Buffer.byteLength(content)),
	);
	const conditional = await worker.fetch(
		new Request(url, {
			headers: { ...headers, "if-none-match": `"other", W/${etag}` },
		}),
		config,
	);
	assert.equal(conditional.status, 304);
	assert.equal(await conditional.text(), "");
	assert.equal(reads, 1);
	const avif = await worker.fetch(
		new Request(url, { headers: { accept: "image/avif" } }),
		config,
	);
	assert.equal(avif.headers.get("content-type"), "image/avif");
	await avif.text();
	const still = await worker.fetch(
		new Request(`${url}?static=true`, { headers }),
		config,
	);
	assert.equal(((await still.json()) as { anim: boolean }).anim, false);
	assert.equal(reads, 3);
	const freshHead = await worker.fetch(
		new Request(signedUrl(undefined, true), { method: "HEAD", headers }),
		config,
	);
	assert.equal(freshHead.status, 200);
	assert.equal(await freshHead.text(), "");
	assert.equal(reads, 4);
});

test("client cancellation during preview generation does not invoke either fallback", async (t) => {
	for (const fallback of ["pleroma", "original"] as const) {
		const abort = new AbortController();
		const config = previewEnv();
		config.PREVIEW_FALLBACK = fallback;
		let reads = 0;
		t.mock.method(globalThis, "fetch", async () => {
			reads++;
			return new Response("image", {
				headers: { "content-type": "image/png" },
			});
		});
		assert(config.IMAGES);
		t.mock.method(config.IMAGES, "input", () => {
			abort.abort(new Error("client disconnected"));
			throw abort.signal.reason;
		});
		await assert.rejects(
			worker.fetch(
				new Request(signedUrl(undefined, true), { signal: abort.signal }),
				config,
			),
			/client disconnected/,
		);
		assert.equal(reads, 1);
		t.mock.restoreAll();
	}
});

test("preview cache reuses entries for Accept headers with the same format ranking", async (t) => {
	const entries = new Map<string, Response>();
	Object.defineProperty(globalThis, "caches", {
		configurable: true,
		value: {
			default: {
				async match(request: Request) {
					return entries.get(request.url)?.clone();
				},
				async put(request: Request, response: Response) {
					entries.set(request.url, response);
				},
			},
		},
	});
	t.after(() => {
		Reflect.deleteProperty(globalThis, "caches");
	});
	let reads = 0;
	t.mock.method(globalThis, "fetch", async () => {
		reads++;
		return new Response("image", { headers: { "content-type": "image/png" } });
	});
	const url = signedUrl(undefined, true);
	const config = previewEnv();
	for (const accept of ["image/webp", "image/webp;q=1", "IMAGE/WEBP;Q=1.0"]) {
		const response = await worker.fetch(
			new Request(url, { headers: { accept } }),
			config,
		);
		assert.equal(response.headers.get("content-type"), "image/webp");
		await response.text();
	}
	assert.equal(reads, 1);
	assert.equal(entries.size, 1);
	const other = await worker.fetch(
		new Request(url, {
			headers: { accept: "image/webp;q=1,image/avif;q=0.5" },
		}),
		config,
	);
	assert.equal(other.headers.get("content-type"), "image/webp");
	await other.text();
	assert.equal(reads, 2);
});
