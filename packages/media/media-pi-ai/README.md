---
description: "The shipped OpenAI-compatible media provider: configured vendor routes, credential resolution through the credentials seam, and the image and video wire dialects it speaks behind ctx.media."
kind: "package-reference"
---

# @deepseek-ai/dsh-media-pi-ai

English | [中文](README.zh.md)

## Summary

Mount `dsh-media-pi-ai` when a composition needs images or video from an OpenAI-compatible vendor. It registers one implementation into `ctx.media`, resolves each request's route and credential, and is the only package where media vendor HTTP appears. Routes come from the plugin config and the `media-pi-ai` user-settings section, so an endpoint or credential change reaches the next call without a restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the media seam first, then this provider:

```yaml
- name: '@deepseek-ai/dsh-media'
- name: '@deepseek-ai/dsh-media-pi-ai'
  config:
    providers:
      agnes:
        displayName: Agnes AI
        apiKeyEnv: BF_AGNES_BUILTIN_API_KEY
        api: agnes
        baseURL: https://api.agnes-ai.cn/v1
      local:
        displayName: Local server
        baseURL: http://127.0.0.1:8000/v1
```

Each route declares its base URL, an optional credential ref, and a wire dialect. A caller then names the route id and the vendor model in its request. A route with no `apiKeyEnv` is called without an authorization header, which is what a same-host server needs.

### Configuration

| Field | Meaning |
|---|---|
| `providers` | Routes by id. A request's `provider` field selects one; an unknown id fails with `MEDIA_ROUTE_UNKNOWN`. |
| `displayName` | Label for configuration surfaces; the route id is used when omitted. |
| `baseURL` | Vendor base URL, with or without a version suffix. |
| `apiKeyEnv` | Credential ref resolved through the credentials seam, or the environment variable holding the key. |
| `api` | Wire dialect: `openai` (default) or `agnes`. |

The provider reports itself unavailable while no route is configured, so a bare mount is dormant rather than failing calls inside the vendor.

<a id="understand-the-implementation"></a>
## Understand the implementation

`openai` speaks the OpenAI-compatible field names (`size`, `resolution`, `aspect_ratio`) over `/videos/generations` plus `/videos/<id>`, and posts plain JSON. `agnes` speaks the Agnes AI contract: tier and ratio on images, `seconds` as a string in `4`..`12` on video, a `mode`-selected reference block, and the `/agnesapi` status document on the origin. A submission the vendor rejects with its accepted sizes is retried once at the closest reported size.

Vendor answers are normalized before they leave the package: an image or video URL is downloaded here, base64 is decoded here, and a non-2xx, missing, or unusable answer becomes the matching `MediaError` code with the vendor status. Retry, budget, and scheduling stay with the caller.

<a id="further-exploration"></a>
## Further Exploration

- [@deepseek-ai/dsh-media](../media/README.md) — the service this provider implements.
- [@deepseek-ai/dsh-llm-pi-ai](../../llm/llm-pi-ai/README.md) — the model-side provider that reads the same settings and credentials seams.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package generates media artifacts for its callers and registers no prompt, tool schema, or request field.

#### KV Cache effect

No direct invalidation; the package never contributes request-prefix content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No request log or usage accounting** — calls are not recorded and no credit or byte totals are produced; a deployment that needs replay records it in the consumer.
- **One dialect pair per route** — a vendor that changes shape per model (rather than per deployment) is not expressible today.
- **No webhook or push intake** — asynchronous vendors are polled by the caller through `ctx.media.pollVideo()`; there is no callback endpoint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
