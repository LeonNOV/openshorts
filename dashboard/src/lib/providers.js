/**
 * The Fish Audio TTS models, mirrored from the backend (fish_audio.py) so
 * the dropdown can render before the first request goes out. The backend is
 * the source of truth — /api/saasshorts/voices returns the same list.
 */
export const FISH_AUDIO_MODELS = [
    { id: 's2.1-pro', label: 'S2.1 Pro', hint: 'recommended' },
    { id: 's2.1-pro-free', label: 'S2.1 Pro Free', hint: 'free tier' },
    { id: 's2-pro', label: 'S2 Pro', hint: 'previous gen' },
    { id: 's1', label: 'S1', hint: 'previous gen' },
];

/** The LLM providers the pipeline's text stages can answer with. */
export const LLM_PROVIDERS = [
    { value: 'gemini', label: 'Gemini', hint: 'google' },
    { value: 'deepseek', label: 'DeepSeek', hint: 'deepseek' },
];

/** The voice providers that can synthesize a voice. */
export const TTS_PROVIDERS = [
    { value: 'elevenlabs', label: 'ElevenLabs', hint: 'dubbing api' },
    { value: 'fish_audio', label: 'Fish Audio', hint: 'voice models' },
];
