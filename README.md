# cf-pleroma-proxy

A Cloudflare Worker for the signed media proxy URLs that Pleroma generates. It
verifies the signatures and serves media and previews.

Regular media requests fetch the remote file directly. Previews come from
Cloudflare Images and Media Transformations, from Pleroma, or from the original
file, depending on the configuration.

## Requirements

- Pleroma with `media_proxy` and `media_preview_proxy` enabled.
- A Cloudflare account and a proxied hostname for your Pleroma instance. The
  Worker runs on a route for that hostname.
- Node.js 26 or later and pnpm 12 or later, or the locked Nix shell with
  `nix develop`.

Worker previews use Cloudflare Images and Media Transformations. To let Pleroma
generate previews instead, set `PREVIEW_MODE = "pleroma"` and remove the
`[images]` and `[media]` bindings.

## Deployment

1. Install dependencies.

   ```sh
   git clone https://github.com/XYenon/cf-pleroma-proxy.git
   cd cf-pleroma-proxy
   pnpm install --frozen-lockfile
   ```

2. Enable both proxies in Pleroma and apply the change.

   ```elixir
   config :pleroma, :media_proxy, enabled: true
   config :pleroma, :media_preview_proxy, enabled: true
   ```

3. Copy the example configuration and edit it.

   ```sh
   cp wrangler.example.toml wrangler.toml
   ```

   Set the route to your instance hostname and Cloudflare zone, and update
   `USER_AGENT` with your instance URL and contact address. For an instance at
   `social.example.org` the route is:

   ```toml
   routes = [{ pattern = "social.example.org/proxy/*", zone_name = "example.org" }]
   ```

   Keep `workers_dev = false` and put Pleroma behind the route, because the
   fallback sends same-URL subrequests to Pleroma. A `workers.dev` endpoint or a
   Worker Custom Domain cannot do this. `wrangler.toml` is ignored by Git.

4. Store Pleroma's `secret_key_base` as a Worker secret.

   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler secret put SECRET_KEY_BASE
   ```

   If Wrangler asks to create the Worker, use the name from `wrangler.toml`.
   Keep the secret out of `wrangler.toml`, Git and issue reports.

5. Check, build and deploy.

   ```sh
   pnpm run check
   pnpm run test
   pnpm run build
   pnpm run deploy
   ```

   `pnpm run build` bundles the Worker. `pnpm run deploy` publishes it and
   applies the route.

Open a remote media attachment in your instance and check that the media and the
preview load, and that a repeated request reports `Cf-Cache-Status: HIT`. Unsigned
URLs and `/proxy/invalid` return 403. To check a fallback policy, request a
signed URL whose remote source is unavailable.

## Configuration

Set the variables below in `[vars]` in `wrangler.toml`. `SECRET_KEY_BASE` is
required and must match Pleroma's `secret_key_base`. `USER_AGENT` is required and
identifies your instance to remote servers. The example file uses the defaults
described here.

### Media fallback

| `MEDIA_FALLBACK`    | Behavior                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `pleroma` (default) | On direct fetch failure, forward the request to Pleroma.                 |
| `error`             | On direct fetch failure, return HTTP 502 with `Cache-Control: no-store`. |

The setting applies to requests that are not previews.

### Preview mode and fallback

| Variable           | Value               | Behavior                                                                   |
| ------------------ | ------------------- | -------------------------------------------------------------------------- |
| `PREVIEW_MODE`     | `worker` (default)  | Generate previews with the `IMAGES` and `MEDIA` bindings.                  |
|                    | `pleroma`           | Forward preview requests to Pleroma, including its redirects.              |
|                    | `original`          | Serve the original media instead of a preview.                             |
| `PREVIEW_FALLBACK` | `pleroma` (default) | On Worker preview failure, let Pleroma generate the preview.               |
|                    | `original`          | On Worker preview failure, serve the original media.                       |
|                    | `error`             | On Worker preview failure, return HTTP 502 with `Cache-Control: no-store`. |

`PREVIEW_FALLBACK` applies only to `PREVIEW_MODE = "worker"`. Keep
`media_preview_proxy` enabled in Pleroma for every mode, because its API emits
`/proxy/preview/` URLs.

The example includes both bindings:

```toml
[images]
binding = "IMAGES"

[media]
binding = "MEDIA"
```

### Edge caching

The example enables [Workers Cache](https://developers.cloudflare.com/workers/cache/)
with `[cache] enabled = true`, so Cloudflare can serve cached responses without
running the Worker. Remove the `[cache]` block to disable it. Billing and cache
details are in [docs/behavior.md](docs/behavior.md#edge-caching).

## Behavior

The direct proxy follows the header and MIME rules in [Pleroma develop](https://git.pleroma.social/pleroma/pleroma/src/commit/687fa6e1b222ec3ebd1d7eb400b579ea86333312/lib/pleroma/reverse_proxy.ex).
It supports GET, HEAD, optional filenames, ranges and conditional requests, and
it caches direct responses for 14 days.

See [docs/behavior.md](docs/behavior.md) for response headers and MIME handling,
body streaming, preview generation, edge caching, fallbacks, and the Pleroma
settings the Worker does not copy.

## Development

Copy the example configuration and secret file, then start Wrangler:

```sh
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
pnpm run dev
```

`.dev.vars` is ignored by Git, and its example value cannot validate URLs from
your instance. Local Wrangler does not reproduce the production route's same-URL
forwarding to Pleroma, so check that with a separate instance and route.

The Node tests cover routing, service integration, format negotiation and
fallbacks. Wrangler's offline Images implementation has limited features, and
Media has none. To test real video encoding, set `remote = true` in `[media]` and
use a Cloudflare account.

Run `pnpm run check`, `pnpm run test` and `pnpm run build` before submitting
changes, `pnpm run format` to format files, and `pnpm run lint:fix` to apply
safe lint fixes. CI validates the example with
`pnpm run build --config wrangler.example.toml`.

`pnpm run typecheck` generates runtime types from `wrangler.example.toml` before
checking the Worker and the tests. Run `pnpm run typegen` after installing
dependencies or changing the compatibility date. The generated
`worker-runtime.d.ts` is ignored by Git, and application environment types live
in `worker-configuration.d.ts`.

## License

Copyright (C) 2023-2026 XYenon.

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full terms.

The SPDX identifier is `AGPL-3.0-or-later`. If you run a modified version as a
network service, provide its users with access to the corresponding source as
required by section 13 of the license. The upstream source is available at
<https://github.com/XYenon/cf-pleroma-proxy>.
