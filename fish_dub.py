"""Dubbing a finished clip with Fish Audio.

ElevenLabs' Dubbing API takes the whole video and returns it dubbed. Fish
Audio has no equivalent video-level endpoint, so this module does the same
job from the parts the pipeline already has:

1. The clip's transcript, with per-segment timings, is in the job metadata.
2. The text is translated into the target language by the configured LLM.
3. Each translated segment is synthesized by Fish Audio (``POST /v1/tts``).
4. The segments are laid back on the original timeline and replace the clip's
   audio.

The result keeps the original timing, so the mouth still lines up with the
words, and it is the dubbed speech that carries the clip — the original
audio is replaced rather than mixed, because there is no stem separation
here and two overlapping voices are worse than none.
"""
from __future__ import annotations

import os
import subprocess
from typing import Callable, List, Optional

import fish_audio

# The languages Fish Audio speaks well enough to dub into. The dubbing UI
# offers the same list ElevenLabs does, so this only narrows what Fish Audio
# can actually deliver.
SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "pl": "Polish",
    "hi": "Hindi",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "ar": "Arabic",
    "ru": "Russian",
    "tr": "Turkish",
    "nl": "Dutch",
    "sv": "Swedish",
    "id": "Indonesian",
    "fil": "Filipino",
    "ms": "Malay",
    "vi": "Vietnamese",
    "th": "Thai",
    "uk": "Ukrainian",
    "el": "Greek",
    "cs": "Czech",
    "fi": "Finnish",
    "ro": "Romanian",
    "da": "Danish",
    "bg": "Bulgarian",
    "hr": "Croatian",
    "sk": "Slovak",
    "ta": "Tamil",
}


def segments_for_clip(transcript: dict, clip_start: float, clip_end: float) -> List[dict]:
    """The transcript segments that fall inside a clip, with their timings.

    Each entry is ``{"start", "end", "text"}`` with the timings already
    relative to the clip's own start, so they can be used directly as
    placement offsets.
    """
    out = []
    for segment in (transcript or {}).get("segments", []):
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", 0.0))
        if end <= clip_start or start >= clip_end:
            continue
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "start": max(0.0, start - clip_start),
            "end": max(0.0, end - clip_start),
            "text": text,
        })
    return out


def translate_segments(segments: List[dict], target_language: str,
                       translate_fn: Callable[[List[str], str], List[str]]) -> List[dict]:
    """Translate every segment's text into ``target_language``.

    ``translate_fn`` takes the list of source texts and the target language
    name and returns the translations in the same order. It is injected so
    this module does not care which LLM provider is configured.
    """
    if not segments:
        return []
    language_name = SUPPORTED_LANGUAGES.get(target_language, target_language)
    translated = translate_fn([s["text"] for s in segments], language_name)
    if len(translated) != len(segments):
        raise Exception(
            f"Translation returned {len(translated)} lines for {len(segments)} segments")
    out = []
    for seg, text in zip(segments, translated):
        merged = dict(seg)
        merged["text"] = (text or "").strip()
        out.append(merged)
    return out


def synthesize_segments(segments: List[dict], api_key: str, work_dir: str,
                        model: Optional[str] = None,
                        voice_id: Optional[str] = None) -> List[str]:
    """Synthesize every segment and return the audio file paths."""
    os.makedirs(work_dir, exist_ok=True)
    paths = []
    for i, seg in enumerate(segments):
        if not seg.get("text"):
            paths.append("")
            continue
        path = os.path.join(work_dir, f"seg_{i:04d}.mp3")
        fish_audio.generate_speech(seg["text"], api_key, path,
                                   model=model or fish_audio.default_model(),
                                   reference_id=voice_id or None)
        paths.append(path)
    return paths


def build_dubbed_audio(video_path: str, output_path: str, segments: List[dict],
                       audio_paths: List[str], duration: float) -> str:
    """Lay the synthesized segments on the original timeline and replace the
    clip's audio with them.

    Each segment is delayed to its own start time and the lot is mixed; the
    result is trimmed to the clip's duration so the video and the audio end
    together.
    """
    usable = [(seg, p) for seg, p in zip(segments, audio_paths) if p]
    if not usable:
        raise Exception("No synthesized audio to place on the timeline.")

    cmd = ["ffmpeg", "-y", "-i", video_path]
    for _, path in usable:
        cmd += ["-i", path]

    chains = []
    labels = []
    for i, (seg, _) in enumerate(usable, start=1):
        delay_ms = int(round(seg["start"] * 1000))
        chains.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[a{i}]")
        labels.append(f"[a{i}]")
    mix_in = "".join(labels)
    chains.append(f"{mix_in}amix=inputs={len(usable)}:duration=longest:"
                  f"dropout_transition=0:normalize=0[mixed]")
    chains.append(f"[mixed]apad,atrim=0:{max(0.1, duration):.3f},"
                  f"asetpts=N/SR/TB[aout]")

    cmd += [
        "-filter_complex", ";".join(chains),
        "-map", "0:v:0", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if result.returncode != 0 or not os.path.exists(output_path) \
            or os.path.getsize(output_path) == 0:
        raise Exception(f"ffmpeg failed to build the dubbed audio: {result.stderr[-500:]}")
    return output_path


def dub_clip(video_path: str, output_path: str, transcript: dict,
             clip_start: float, clip_end: float, target_language: str,
             api_key: str, work_dir: str,
             translate_fn: Callable[[List[str], str], List[str]],
             model: Optional[str] = None,
             voice_id: Optional[str] = None) -> str:
    """Dub one clip into ``target_language`` with Fish Audio.

    ``translate_fn`` is the configured LLM's translator (see
    ``llm_provider``); it is injected so the module stays provider-agnostic.
    """
    segments = segments_for_clip(transcript, clip_start, clip_end)
    if not segments:
        raise Exception(
            "This clip has no transcript, so there is nothing to dub. "
            "Fish Audio synthesizes speech from text; it cannot transcribe.")

    translated = translate_segments(segments, target_language, translate_fn)
    audio_paths = synthesize_segments(translated, api_key, work_dir,
                                      model=model, voice_id=voice_id)
    duration = max(0.1, clip_end - clip_start)
    return build_dubbed_audio(video_path, output_path, translated, audio_paths, duration)
