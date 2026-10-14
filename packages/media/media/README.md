---
description: "The media generation service (ctx.media): how deployments and plugin authors generate images and submit and poll video jobs through interchangeable providers, with one selection policy and error vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-media

English | [中文](README.zh.md)

## Summary

Use `dsh-media` to generate an image or run a video job without tying callers to a specific vendor. It selects a usable provider for each call and gives callers one cancellation, result, and error vocabulary. Choose it for plugins or application services that need vendor media generation; a composition without a registered provider fails every call with a structured `MediaError` rather than reaching a vendor on its own.

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

A composition that needs media generation loads the `dsh-media` service and mounts at least one provider — the shipped OpenAI-compatible one is `dsh-media-pi-ai` — and callers then use `ctx.media.generateImage()`, `ctx.media.submitVideo()`, and `ctx.media.pollVideo()`. The service resolves the provider per call, so callers never see provider ids unless the deployment configured one.

### When to choose it

Choose the service when a plugin or application service must produce media without hard-coding a vendor endpoint, credential, or wire dialect. A deployment that only talks to models does not need it. The service adds no network access of its own: with no usable provider registered, every operation fails with a structured `MediaError`.

### Minimal configuration

Load the service and let a single mounted provider auto-select, or pin one with `provider`:

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
```

Each request names the route it targets (`provider`) and the vendor model (`model`); the provider implementation resolves that route's endpoint and credential.

### Operations and their results

| Operation | Request carries | Result |
|---|---|---|
| `generateImage` | prompt, count, size tier, aspect ratio, a vendor size the route already accepted | decoded images with their content type, plus the size the vendor accepted |
| `submitVideo` | prompt, duration, size tier, aspect ratio, reference images or talking-head inputs | a job id to poll, or an already finished video |
| `pollVideo` | the job id and the submitting model | `pending`, `completed` with the video artifact, or `failed` with the vendor's reason |

A talking-head request carries reference images, optional reference audio, and at most one reference video (`MediaTalkingHead.videos`) of 2–12 seconds and under 50 MB; whether a reference video is accepted depends on the vendor model.

A vendor that answers with a non-2xx status, that never answers, or that answers without a usable result is reported as `MEDIA_VENDOR_REJECTED` (with the status), `MEDIA_VENDOR_UNREACHABLE`, or `MEDIA_VENDOR_NO_RESULT`. Callers keep their own retry, budget, and scheduling policy; the seam owns only the vendor round trip.

Every operation also reports one `MediaObservation` on the `media/observation` event after it settles — success or failure, with input size, output size, the seam's own duration measurement, and the failure classification. Subscribe to make media work visible in your own traces; the seam reports, your deployment decides what to keep. A listener that throws cannot change the call's outcome.

Classify those failures with `isMediaError()`, never `instanceof`: one process can hold two physical copies of this package — a package manager injects one copy per dependent's peer set — and an error raised by the provider's copy is not an instance of the class a caller imported. `instanceof` then degrades every classification silently, retry decisions included (DEF-169).

<a id="understand-the-implementation"></a>
## Understand the implementation

`MediaRuntime` holds a registry of providers keyed by id. Selection happens at call time and never depends on registration order: a configured id must be registered and usable, and without one exactly one usable provider is required — zero or several become `MEDIA_PROVIDER_UNAVAILABLE` and `MEDIA_PROVIDER_AMBIGUOUS`. A duplicate registration is rejected with `MEDIA_PROVIDER_DUPLICATE`, and every registration is an effect that the contributing fiber's disposal removes.

The definition owns the vocabulary and the selection policy only. Endpoints, credentials, wire dialects, and artifact downloads belong to the provider package, so a vendor can be replaced without touching a caller.

<a id="further-exploration"></a>
## Further Exploration

- [Architecture](../../../docs/architecture.md) — where capability seams sit in the composition.
- [@deepseek-ai/dsh-media-pi-ai](../media-pi-ai/README.md) — the shipped OpenAI-compatible provider.
- [@deepseek-ai/dsh-web](../../web/web/README.md) — the seam that follows the same registry and selection policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes no prompt, tool schema, or request field; the consumer that renders or references generated media owns every model-visible effect.

#### KV Cache effect

No direct invalidation; the package never contributes request-prefix content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No progress or usage surface** — a call resolves when the vendor answered; there is no event stream for queue position, and no token, credit, or byte accounting. A caller that needs cost facts reads them from its own records.
- **Artifacts arrive whole** — image and video bytes are buffered in memory before they reach the caller, so this seam targets vendor-delivered clips rather than multi-gigabyte renders.
- **No streaming or partial delivery** — every operation is request/response; a vendor that only offers a webhook or a push channel needs a provider that polls or adapts it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
