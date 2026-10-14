# Agent Note: media capability seam

Status: implemented

English | [中文](2026-09-23-media-capability-seam.zh.md)

## Problem

The Harness owned text generation but no image, video, or speech generation. Applications therefore reached vendor endpoints directly: each one re-derived endpoint layout, authentication headers, timeouts, size negotiation, and polling, so a vendor change edited application code, credentials lived in application files instead of the credentials seam, and no gate could tell which package was allowed to open a vendor connection.

## Decision

`ctx.media` is the media capability seam. `@deepseek-ai/dsh-media` defines three operations — `generateImage`, `submitVideo`, `pollVideo` — plus one provider registry, a request/result vocabulary, and a `MediaError` taxonomy. A video request carries reference material through `MediaTalkingHead`; `MediaTalkingHead.videos` (`MediaReferenceVideo`) adds a reference clip as a publicly readable URL or a data URI, with an optional start second and an optional audio requirement. Speech is not part of the seam; [vendor-native speech](2026-09-25-vendor-native-speech.md) owns that decision. Selection is resolved per call and never depends on registration order: a configured provider id must be registered and usable, and without one exactly one usable provider is required.

`@deepseek-ai/dsh-media-pi-ai` is the shipped provider and the only package where media vendor HTTP appears. It resolves each request's route and credential (through the credentials seam, or the environment when that seam is absent), speaks either the OpenAI-compatible dialect or the Agnes dialect, and normalizes what comes back: image and video artifacts are downloaded or decoded inside the provider, and a non-2xx, absent, or unusable vendor answer becomes `MEDIA_VENDOR_REJECTED` (carrying the status), `MEDIA_VENDOR_UNREACHABLE`, or `MEDIA_VENDOR_NO_RESULT`.

Routes come from the provider's plugin config and the `media-pi-ai` user-settings section, as the model-side provider reads `llm-pi-ai`; a route without a credential ref is called anonymously, which a same-host server needs. Retry, budget, scheduling, and persistence stay with the caller: the seam owns one vendor round trip.

## Alternatives considered

**Ship only the provider, without a service definition.** An application would still name a vendor in its own code, so replacing that vendor would edit the application again, and a gate could not distinguish a permitted provider package from an application reaching a vendor directly.

**Return the raw vendor response.** Callers would then branch on vendor status codes and response shapes, which puts the dialect back in every consumer and makes a second dialect a breaking change for all of them.

**Own retry, backoff, and polling inside the seam.** Consumers disagree: an interactive request wants one bounded attempt with a readable failure, while a long-running pipeline wants its own retry budget and resumable jobs. Keeping policy in the consumer lets both use one wire contract.

## Consequences

A composition with no configured route reports every operation as `MEDIA_PROVIDER_UNAVAILABLE` or `MEDIA_ROUTE_UNKNOWN` and reaches no network; a bare mount is dormant rather than silently direct. Media artifacts are buffered in memory before they reach the caller, so the seam targets vendor-delivered clips rather than multi-gigabyte renders. A route that offers no video reference reports `MEDIA_OPERATION_UNSUPPORTED` instead of quietly dropping the clip. The seam records no request log or usage totals; a deployment that needs replay records it in the consumer.

Verification: both packages carry specs at 100% per-file coverage, including a loopback fake vendor that exercises both dialects, credential resolution through the credentials seam, live settings-section replacement, rejection, unreachable, and no-result paths.
