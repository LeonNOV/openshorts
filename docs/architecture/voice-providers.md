# Voice providers

Two providers make a voice, and the user picks one: **ElevenLabs** (the
default) or **Fish Audio**. They are either/or — the selected provider's key
is the one that gets used, and the other provider's key is never sent.

## The shape of each provider

| | ElevenLabs | Fish Audio |
|---|---|---|
| Voiceover (text → audio) | `POST /v1/text-to-speech/{voice_id}` | `POST /v1/tts` |
| Voice list | `GET /v1/voices` | `GET /model?self=true` |
| Model | in the body (`model_id`) | in the **`model` header** |
| Voice id | `voice_id` | `reference_id` |
| Dubbing a finished clip | its Dubbing API (uploads the video) | synthesized from the transcript |

`fish_audio.py` is the Fish Audio half; `tts.py` is the facade both providers
answer through, so nothing above it knows which one is in play.

## What Fish Audio changes about dubbing

ElevenLabs' Dubbing API takes the whole video and returns it dubbed, so the
provider owns the translation. Fish Audio has no video-level endpoint, so
`fish_dub.py` does the same job from the parts the pipeline already has:

1. The clip's transcript, with per-segment timings, is in the job metadata
   (`*_metadata.json`). `segments_for_clip` slices out the segments that fall
   inside the clip and shifts their timings to be clip-relative.
2. `llm_provider.translate` translates them into the target language, one
   array in and one array out, so the lines stay paired with the timings.
3. Fish Audio synthesizes each segment.
4. `build_dubbed_audio` delays each segment to its own start time, mixes them
   and trims to the clip's duration, so the words still land on the mouth.

**The original audio is replaced, not mixed.** There is no stem separation
here, and two overlapping voices are worse than one.

**A clip with no transcript cannot be dubbed this way.** Fish Audio speaks
text; it cannot transcribe a video. The endpoint says so instead of failing
vaguely. A recut clip is remapped with `recut.virtual_transcript` first, so
its timings are already clip-relative.

## The models

Fish Audio picks a model per call, and the choice is per generation:

- `s2.1-pro` — recommended; best quality, multi-speaker, emotion tags
- `s2.1-pro-free` — the same model at $0; no latency or uptime guarantee
- `s2-pro` — previous generation
- `s1` — previous generation

`speech-1.5` and `speech-1.6` were retired on 2026-02-28 and `s1` is on its
way out, so they are not offered. The list lives in `fish_audio.py` and is
served by `/api/saasshorts/voices` — the backend is the source of truth, the
dashboard mirrors it in `dashboard/src/lib/providers.js`.

Fish Audio's voice library is the account's own clones, not a catalogue of
preset voices. Only voices in the `trained` state can speak, so the others are
filtered out before the user picks one. A clone tagged `male` reads as a male
voice in the dashboard's filters, which is how the two providers' lists end up
with the same shape.

## Where the choice reaches the backend

| Request | Header | Body field |
|---|---|---|
| `/api/saasshorts/generate` | `X-Fish-Audio-Key` | `tts_provider`, `tts_model` |
| `/api/saasshorts/voices` | `X-Fish-Audio-Key` | `?provider=fish_audio` |
| `/api/translate` | `X-Fish-Audio-Key` | `tts_provider`, `tts_model`, `tts_voice_id` |

The key of the *chosen* provider is required; the other provider's key is
ignored. `tts_provider` is validated against the known set, so a typo is a
400 and not a silent fallback.

## The AI Act marking

A dubbed file carries a machine-readable AI-generated tag
(`ffmpeg_utils.mark_ai_generated`), on both paths: the voice in the file was
synthesised, and the person publishing it is the one who owes the audience the
disclosure.
