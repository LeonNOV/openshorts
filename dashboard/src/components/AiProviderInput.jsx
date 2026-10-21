import React from 'react';
import { Key } from 'lucide-react';
import KeyInput from './KeyInput';
import SegmentedControl from './ui/SegmentedControl';

/**
 * The AI model the pipeline's text stages answer with: Gemini or DeepSeek.
 *
 * They are either/or — the selected provider's key is what the pipeline
 * uses. DeepSeek covers the text work (picking clips, writing titles and
 * scripts); the frame-based stages (layout detection, on-screen content,
 * hook grounding) still need a Gemini key, because only Gemini looks at
 * frames. With a Gemini key set, both work: DeepSeek writes, Gemini sees.
 */
export default function AiProviderInput({ provider, onProviderChange, geminiKey, onGeminiKeyChange, deepseekKey, onDeepseekKeyChange }) {
    return (
        <div className="animate-fade">
            <div className="card p-4 sm:p-6 mb-4">
                <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-paper3 rounded-input text-brass">
                        <Key size={18} />
                    </div>
                    <h2 className="font-display lowercase text-lg text-ink">AI Model</h2>
                </div>
                <label className="eyebrow block mb-2">Text model</label>
                <SegmentedControl
                    options={[
                        { value: 'gemini', label: 'Gemini', hint: 'google' },
                        { value: 'deepseek', label: 'DeepSeek', hint: 'deepseek' },
                    ]}
                    value={provider}
                    onChange={onProviderChange}
                    columns={2}
                />
                <p className="text-xs text-muted mt-4 leading-relaxed">
                    {provider === 'deepseek'
                        ? 'DeepSeek writes the copy: it picks the clips, writes the titles and the scripts. Layout detection still looks at frames, so it keeps using Gemini when a Gemini key is set — switch back to Gemini below to change that key.'
                        : 'Gemini does everything: it picks the clips, writes the titles and the scripts, and reads the frames for layout detection.'}
                </p>
            </div>

            {provider === 'deepseek' ? (
                <KeyInput
                    onKeySet={onDeepseekKeyChange}
                    savedKey={deepseekKey}
                    label="DeepSeek API Key"
                    placeholder="sk-..."
                    linkUrl="https://platform.deepseek.com/api_keys"
                    linkText="Get your DeepSeek API Key here →"
                />
            ) : (
                <KeyInput
                    onKeySet={onGeminiKeyChange}
                    savedKey={geminiKey}
                />
            )}
        </div>
    );
}
