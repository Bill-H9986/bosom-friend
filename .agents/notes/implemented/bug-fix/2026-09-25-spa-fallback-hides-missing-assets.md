# Agent Note: Missing static assets fail loud instead of answering index.html

Status: implemented

English | [中文](2026-09-25-spa-fallback-hides-missing-assets.zh.md)

## Problem

The Bosom Friend static server (`serveSpa` in `products/bosom-friend/server/src/http.ts`) answered every path that missed a file with `dist/index.html` and status 200. A browser that asked for a hashed chunk therefore received HTML labelled `text/html` where it expected JavaScript, rejected it with `SyntaxError`, and the entry chunk's lazy routes — whose imports the Vite module-preload polyfill never rejects — stayed pending forever.

Rebuilding the frontend makes this reachable: Vite content-hashes chunk names and emits only the current set, so a browser holding the previous `index.html` requests chunks this build deleted. On a remote phone that surfaced as the router's error boundary with the message `未知错误`, because the boundary reports `String(event.error ?? '未知错误')` and a load failure carries no `error`.

The same handler also never served a favicon. Its branch compared the request pathname against `/favicon.ico`, but the handler is registered on the `/bosom-friend` prefix and receives the unstripped pathname `/bosom-friend/favicon.ico`, so the branch had never executed.

## Decision

A request whose path carries a file extension and matches no file is answered `404` with `text/plain`. Only extensionless paths — the hash-route deep links — still fall back to `index.html`, so routing is unaffected. The path-traversal guard keeps running first.

`index.html` responses now carry a weak `ETag` derived from file size and modification time. The existing `cache-control: no-cache` only permits caching *with* revalidation, and revalidation needs a validator: without one the browser reuses its stored copy, which is how a client stays pinned to a replaced entry document.

The favicon branch strips the mount prefix before comparing, and looks for the icon at both `dist/favicon.ico` and `dist/assets/favicon.ico` (Vite copies `public/` verbatim, so the tracked icon lives under `assets/`). The entry document declares `/bosom-friend/favicon.ico`.

The router error boundary appends the failing resource's `src`/`href` and tag name when a `window` error carries no `Error` object, so a future load failure names its address instead of reporting `未知错误`.

## Alternatives considered

**Keep the fallback and force clients to refresh.** The fallback destroys the evidence: any request for anything returns 200 with the application shell, so a monitor, a probe, or a reviewer cannot tell a served asset from a missing one. The wrong-content-type answer is also measurably worse than a 404 — it produces an unrecoverable pending import rather than a failed one.

**Answer missing assets with `204 No Content`.** A bodyless 204 for a script produces the same `SyntaxError` the fix removes, while hiding the status a reader needs. `404` is the only answer that states the fact.

**Return the current `index.html` with `no-store` instead of adding an ETag.** `no-store` also removes stale-entry risk, but it re-downloads the whole document on every navigation, and a hash-route application navigates constantly.

**Serve the favicon at `/favicon.ico` by declaring an absolute path in the entry document.** That path sits outside the `/bosom-friend` prefix, so the product handler never receives it and the host server answers instead; the icon belongs under the application's own base.

## Consequences

A client holding a replaced `index.html` now fails visibly and diagnosably instead of freezing the interface, and a missing asset is reported as missing. The deployed application must still be reloaded once to pick up the new entry document; the ETag makes that revalidation reliable rather than dependent on client eviction.

Requests for a nonexistent extension-bearing deep link now answer 404 instead of the shell. No route in this application is extension-bearing.

`products/bosom-friend/server/test/functional/serve-spa-fallback.spec.ts` drives a real HTTP server over a temporary dist: missing chunks, styles and images must answer 404 with a non-HTML body; an existing chunk must still be served with its JavaScript content type; an extensionless deep link and the root must still answer the shell; and an encoded traversal path must still be refused. Following the file's own contract, the traversal case goes over a raw socket because `fetch` normalizes `..` before the request leaves the client.
