# Worker behavior

The direct proxy follows the header and MIME rules in [Pleroma develop](https://git.pleroma.social/pleroma/pleroma/src/commit/687fa6e1b222ec3ebd1d7eb400b579ea86333312/lib/pleroma/reverse_proxy.ex).

## Requests

- It supports GET, HEAD, optional filenames, ranges and conditional requests.
- A wrong filename redirects to the canonical signed path without the query
  string, matching Pleroma's media proxy controller.

## Response headers

- It filters response headers, cleans MIME types, and applies download and CSP
  sandbox policies. The inline list follows Pleroma develop, which adds APNG,
  AVIF, BMP and WebP to what Pleroma stable serves inline.
- It sets `Cache-Control: public, max-age=1209600, immutable, no-transform` on
  direct responses. Pleroma responses keep their own policy, with
  `no-transform` added when it is missing. Errors use `no-store`, and the
  canonicalization redirect uses a short `max-age`.

## Bodies and sizes

- There is no body size limit, download timeout or failed-request cache. Invalid
  or conflicting `Content-Length` values are rejected, and identical duplicates
  are normalized.
- Known lengths stream through a native `FixedLengthStream` that holds the last
  byte until the upstream end, so clients can detect truncation. Unknown lengths
  stream without buffering the whole file, but an upstream error in such a body
  may look like a clean end of response until
  [workerd #6818](https://github.com/cloudflare/workerd/issues/6818) is fixed.
- Direct fetches ask for identity encoding for accurate ranges and size checks.
  Origins that ignore it use the fallback.

## Previews

Worker previews stay within 600 × 600 pixels and never enlarge small images.
Images are resized with Images, and videos use Media to extract the first frame.
When the browser's `Accept` header prefers AVIF or WebP, Images encodes that
frame with the chosen format.

At equal quality the order is AVIF, WebP, then PNG or JPEG. PNG and GIF sources
prefer PNG over JPEG so transparency survives. `static=true` requests a still
image, while WebP output keeps animation otherwise. AVIF, JPEG and PNG output is
always still, because Images rejects animation for those formats.

Previews are cached per format ranking and `static` value with `Vary: Accept`, so
requests that select the same format share one transformation. Range and
validator headers are not forwarded when generating a preview, and the generated
output is read before responding so a failed conversion can use the fallback.
Only successful previews are cached.

Images binding inputs are limited to 20 MB, and Media supports fewer video
formats than ffmpeg. Unsupported media, missing bindings, service errors and
invalid output all use the fallback, including SVG, because Images does not
rasterize it into a thumbnail. See the [Images limits](https://developers.cloudflare.com/images/get-started/limits/),
[Images pricing](https://developers.cloudflare.com/images/pricing/), and
[Media binding documentation](https://developers.cloudflare.com/stream/transform-videos/bindings/).

## Edge caching

[Workers Cache](https://developers.cloudflare.com/workers/cache/) is enabled in
the example with `[cache] enabled = true`, so Cloudflare can serve media and
previews without running the Worker. Cache hits use no CPU time, every request is
billed at the standard Workers request rate, and each deployment starts with an
empty cache. Workers Cache needs Wrangler 4.69.0 or later.

## Fallbacks

The media fallback applies to failures detected before the response starts
streaming. Later body errors fail the stream, HEAD error responses have no body,
and URLs on the proxy's own hostname always go to Pleroma.

Preview fallbacks apply only to `PREVIEW_MODE = "worker"`. When fetching original
media fails in `original` mode or in a fallback, the Worker returns 502.

## Differences from Pleroma

Pleroma's media ban list is not checked by the direct proxy, and Pleroma's custom
MIME, download, size and timeout settings are not copied to the Worker.
