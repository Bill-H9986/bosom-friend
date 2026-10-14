# Agent Note: Vendor-native speech for long-video renders

Status: implemented

English | [中文](2026-09-25-vendor-native-speech.zh.md)

## Problem

The product synthesized its own speech: `msedge-tts` rendered each sentence, `ffmpeg` stitched the sentences with inserted pauses, and the result either reached the video vendor as talking-head reference audio or was attached to non-talking-head shots as a voice-over. The vendor speaks only when the prompt tells it to, so the two halves did not meet.

Measured on 2026-09-25 on a 15-shot one-minute film: 14 of the 15 shots carried a digitally silent audio track (mean −63 to −85 dB). The mother clock — the per-shot duration plan the product committed before spending vendor calls — was computed from the locally synthesized lengths, and the vendor re-voiced every shot to its own timing, so shot lengths and burnt-in subtitles drifted from the plan. The product also carried a whole voice surface — 14 Edge voices, 5 delivery styles, prosody layers with clamping, audition previews, voice cloning, and a user-configured voice provider route written into the kernel settings — to produce a voice the vendor does not model at all: Agnes has no voice id.

## Decision

The media capability seam keeps three operations — `generateImage`, `submitVideo`, `pollVideo` — and carries no speech. The per-route `speech` dialect of `@deepseek-ai/dsh-media-pi-ai` is deleted, and the reference vocabulary gained `MediaTalkingHead.videos` and `MediaReferenceVideo`: a publicly readable URL or a data URI, an optional start second, and an optional audio requirement. Ownership, selection, and dialect rules are unchanged; see [media capability seam](2026-09-23-media-capability-seam.md).

The product deletes `server/src/tts.ts`, `server/src/tts-provider.ts`, the `msedge-tts` dependency, the voice-catalog, delivery-style, prosody, preview, and clone routes, and the 配音来源 settings section. The speech in a render is whatever the vendor produces from the prompt.

Content creation (内容创作) above 12 seconds runs the long-video workflow with the scene producer instead of looping one prompt N times and concatenating the clips. It passes `registerAsMaterial: false` so the generation record stays the artifact's only owner, and copies the finished `videoUrl` back into the generation record. The draft's own text is handed over as `scriptText` only when the draft did not come from the local storyboard template (`response.longVideo === undefined`): the one-minute tier's description is that template rather than a spoken script, and handing it over is rejected as model narration inside the script, so that tier has the workflow write the line from the topic. A successful run writes the script the film actually speaks back into the draft body, so the draft body is the text the film speaks.

## Digital human and shot prompts

A digital human is material + persona + seed.

The material is a photo, or a video from which the create route extracts a first frame into `avatarUrl` and trims a 2–12 s 720p H.264/AAC clip into `sourceVideoUrl`. A talking-head request carries the first frame in `talkingHead.images` and the clip in `talkingHead.videos`.

The persona is an id plus one description drawn from `DIGITAL_HUMAN_PERSONAS` (9 entries). The description is written into every shot prompt, because the vendor generates each shot independently and shares no state between them. Legacy digital-human records keep their read-only `voice` and `voiceStyle` fields, which `personaPrompt` folds onto a persona so those users are not left voiceless.

Long video writes the line verbatim into each shot prompt. A talking-head shot gets 「请让画面里的人用自然的口语说出下面这句话…」 followed by the line; a product, scene, or text-card shot gets 「用画外音（旁白）说出这句话…」. The mother clock is a budget rather than a synthesis pass: `planShotSeconds` returns `clampSegmentSeconds(estimateSeconds(line))` per shot, and the vendor is asked for exactly those seconds. The reconciliation loop that rewrites an undersized script before any vendor call remains, now measured against that budget.

## Alternatives considered

**Keep a product-side TTS as a seam provider.** The seam's provider role normalizes a vendor's wire dialect; hosting a synthesizer there would keep the second clock that produced the silent shots, and the vendor would still be the one speaking in the finished film. Nothing downstream can reconcile two voices.

**Keep the persona as a mapping onto a vendor voice id.** Agnes exposes no voice id, so the mapping has no target to name; the persona would stay a prompt string with an extra indirection between it and the request.

**Keep a synthesized voice-over for non-talking-head shots.** Mixing a local track onto a vendor clip preserves exactly what the measurement found: the vendor's own audio comes back silent, and the mixed track's timing is unrelated to the picture it plays over.

**Use only the extracted first frame and drop the reference video.** The reference video is the only request channel that carries how the person moves and sounds; with the still frame alone, motion and voice are model invention rather than continuation of the user's material.

**Keep cloning and preview as a standalone feature outside long video.** Both exist to pick a voice. A prompt-only persona has no voice to pick, so the surface would advertise a control the vendor cannot honor.

## Consequences

No local audio path exists, so the speech in a render is whatever the vendor renders. A shot can still come back silent when the vendor ignores the clause; the burnt-in subtitle still carries the line. A persona is only a prompt, so it constrains the voice rather than guaranteeing it. A reference video must be a publicly readable URL or an inlined data URI, and the shipped guard rejects an inlined source above 32 MB, below the vendor's own 50 MB limit. Voice cloning and preview are unavailable to users.

## Verification

Both media packages pass their own suites: `pnpm exec vitest run packages/media` reports 79 passing tests across `media.spec.ts`, `vendor.spec.ts`, and `provider.spec.ts`. `pnpm exec tsc -p products/bosom-friend/server/tsconfig.json --noEmit` exits 0, and `node products/bosom-friend/qa/verify-video-duration-wiring.mjs` passes all 10 checks, including the one asserting that the composed-duration branch runs `generateSegmentedVideo` with `registerAsMaterial: false` and that the deleted `generateComposedVideo` path has not returned. The product server's suite was still being rewritten when this note was written, so its measurement is recorded as it came out rather than as a standing property: `pnpm exec vitest run --root products/bosom-friend/server` reported 423 passed and 33 failed over 54 files on 2026-09-25. Every failing file still references the deleted speech surface — `test/audio-join.spec.ts`, `test/functional/digital-human.spec.ts`, `test/functional/long-video.spec.ts`, `test/functional/tts-provider.spec.ts`, `test/functional/voice-clone.spec.ts`, `test/functional/voice-media-route.spec.ts`, and `test/media-trace.spec.ts` — except `test/functional/video-reference.spec.ts`, whose two failures run against the live vendor. That suite is therefore not evidence for the new behavior.

A live end-to-end render is not verified: the Agnes account behind the local credentials has no remaining credit, and a request fails at pre-charge with 403. A probe established that a `mode: reference` request carrying `videos: [{ url: <data URI> }]` passes parameter validation on `agnes-video-2.5` and reaches the billing check, while Agnes documents `videos is not supported` for the flash model. Whether the service can fetch an inlined data URI for the reference video at render time remains unverified.
