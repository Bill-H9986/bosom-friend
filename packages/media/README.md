---
description: "The media package group: the vendor media generation service, the provider registry behind ctx.media, and the shipped OpenAI-compatible provider."
kind: "package-group"
---

# Media packages

English | [中文](README.zh.md)

## Summary

Vendor media generation — images and video jobs — behind one capability seam. The service definition owns the request vocabulary and provider selection; providers own endpoints, credentials, and wire dialects. Mount the service with one provider to generate images and submit and poll video jobs through `ctx.media`.

## Table of Contents

- [Packages](#packages)
- [Where it fits](#where-it-fits)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`media/`](media/README.md) | Service Definition: `ctx.media`, its request/result vocabulary, provider registry, and `MediaError` taxonomy |
| [`media-pi-ai/`](media-pi-ai/README.md) | Service Provider: the shipped OpenAI-compatible implementation, and the only place media vendor HTTP appears |

-----

<a id="where-it-fits"></a>
## Where it fits

A caller reaches media generation through `ctx.media` and never through a vendor endpoint. Adding a vendor means adding a provider package here, not a new call path in an application.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
