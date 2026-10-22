import React, { useState, useEffect } from 'react';
import { Check, X, Loader2, KeyRound, Cpu, ShieldCheck, Rocket } from 'lucide-react';
import { apiJson } from '../lib/api';
import { setSecret } from '../lib/secrets';

// First-run wizard (plan §6.3): self-check → API keys → model size.
// Renders as a full-screen overlay above the app until the user finishes.
export default function FirstRunWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [selfcheck, setSelfcheck] = useState(null);
  const [checking, setChecking] = useState(true);
  const [whisperSizes, setWhisperSizes] = useState([]);
  const [selectedSize, setSelectedSize] = useState('small');

  const [geminiKey, setGeminiKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [voiceKey, setVoiceKey] = useState('');
  const [voiceProvider, setVoiceProvider] = useState('elevenlabs');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const sc = await apiJson('/api/selfcheck');
        setSelfcheck(sc);
        const sizes = sc.whisper_sizes_available || [];
        setWhisperSizes(sizes);
        if (sizes.length) setSelectedSize(sizes[0]);
      } catch (e) {
        setSelfcheck({ ok: false, checks: {}, error: String(e) });
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const checks = selfcheck?.checks || {};

  const CheckRow = ({ ok, label, detail }) => (
    <div className="flex items-start gap-3 py-2">
      <div className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-600'}`}>
        {ok ? <Check size={13} /> : <X size={13} />}
      </div>
      <div className="text-sm">
        <div className="text-ink">{label}</div>
        {detail && <div className="text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );

  const step1Valid = Object.values(checks).every((c) => c.ok);

  const finish = async () => {
    setError('');
    try {
      // Persist whatever the user entered (empty values are simply skipped).
      if (geminiKey) await setSecret('gemini_key', geminiKey);
      if (deepseekKey) await setSecret('deepseekKey_v1', deepseekKey);
      if (voiceKey) {
        if (voiceProvider === 'elevenlabs') await setSecret('elevenLabsKey_v1', voiceKey);
        else await setSecret('fishAudioKey_v1', voiceKey);
      }
      await apiJson('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarded: true, whisperSize: selectedSize }),
      });
      onComplete();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-paper flex items-center justify-center p-4 overflow-auto">
      <div className="card w-full max-w-xl p-6 sm:p-8">
        {/* progress */}
        <div className="flex items-center gap-2 mb-6">
          {[1, 2, 3].map((n) => (
            <div key={n} className={`flex-1 h-1 rounded-full ${n <= step ? 'bg-brass' : 'bg-rule'}`} />
          ))}
        </div>

        {step === 1 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck size={18} className="text-brass" />
              <h2 className="text-lg font-medium text-ink">环境自检</h2>
            </div>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              校验内置 ffmpeg、本地模型与依赖是否就绪。全部通过后才能稳定出片。
            </p>
            {checking ? (
              <div className="flex items-center gap-2 text-muted"><Loader2 className="animate-spin" size={16} /> 检测中…</div>
            ) : (
              <div className="border border-rule rounded-input p-3 bg-paper3/40">
                <CheckRow ok={!!checks.ffmpeg?.ok} label="内置 ffmpeg" detail={checks.ffmpeg?.detail} />
                <CheckRow ok={!!checks.whisper_model?.ok} label="Whisper 模型" detail={checks.whisper_model?.path} />
                <CheckRow ok={!!checks.yolo?.ok} label="YOLO 权重" detail={checks.yolo?.path} />
                <CheckRow ok={!!checks.data_dir_writable?.ok} label="数据目录可写" detail={checks.data_dir_writable?.path} />
                <CheckRow ok={!!checks.python_deps?.ok} label="Python 依赖" detail={checks.python_deps?.missing?.length ? `缺少: ${checks.python_deps.missing.join(', ')}` : '齐全'} />
              </div>
            )}
            <div className="flex justify-end mt-6">
              <button className="btn-primary px-5 py-2 text-sm" disabled={!step1Valid} onClick={() => setStep(2)}>
                下一步
              </button>
            </div>
            {!step1Valid && !checking && (
              <p className="text-xs text-red-600 mt-2">自检未全部通过，请检查上方可定位缺失项后再继续。</p>
            )}
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <KeyRound size={18} className="text-brass" />
              <h2 className="text-lg font-medium text-ink">填 API Key</h2>
            </div>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              至少填一个文本模型 Key（Gemini 或 DeepSeek 二选一）即可出片；语音 Key 可后补。
              密钥仅保存在本机（桌面端存入系统钥匙串）。
            </p>
            <label className="block text-sm text-muted mb-1">Gemini API Key</label>
            <input type="password" className="input-field mb-3" placeholder="AIza..." value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
            <label className="block text-sm text-muted mb-1">DeepSeek API Key <span className="opacity-60">(可选，替代 Gemini 做文本)</span></label>
            <input type="password" className="input-field mb-3" placeholder="sk-..." value={deepseekKey} onChange={(e) => setDeepseekKey(e.target.value)} />
            <label className="block text-sm text-muted mb-1">语音合成 Key <span className="opacity-60">(可选)</span></label>
            <div className="flex gap-2 mb-2">
              <select className="input-field appearance-none cursor-pointer w-40" value={voiceProvider} onChange={(e) => setVoiceProvider(e.target.value)}>
                <option value="elevenlabs">ElevenLabs</option>
                <option value="fishaudio">Fish Audio</option>
              </select>
              <input type="password" className="input-field flex-1" placeholder="sk_..." value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} />
            </div>
            <div className="flex justify-between mt-6">
              <button className="btn-quiet px-4 py-2 text-sm" onClick={() => setStep(1)}>上一步</button>
              <button className="btn-primary px-5 py-2 text-sm" onClick={() => setStep(3)}>下一步</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Cpu size={18} className="text-brass" />
              <h2 className="text-lg font-medium text-ink">选择模型尺寸</h2>
            </div>
            <p className="text-xs text-muted mb-4 leading-relaxed">
              仅列出已内置的 Whisper 模型。体积越大识别越准、越慢。可在设置中随时更改。
            </p>
            <div className="space-y-2">
              {whisperSizes.length === 0 && (
                <div className="text-sm text-muted">未检测到内置模型目录。</div>
              )}
              {whisperSizes.map((s) => {
                const approx = s === 'small' ? '~464 MB' : s === 'medium' ? '~1.5 GB' : s === 'large-v3-turbo' ? '~1.5 GB' : '';
                return (
                  <label key={s} className={`flex items-center gap-3 border rounded-input px-3 py-2 cursor-pointer ${selectedSize === s ? 'border-brass bg-paper3/50' : 'border-rule'}`}>
                    <input type="radio" name="wsize" checked={selectedSize === s} onChange={() => setSelectedSize(s)} />
                    <div>
                      <div className="text-sm text-ink">{s}</div>
                      <div className="text-xs text-muted">{approx}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {error && <p className="text-xs text-red-600 mt-3">{error}</p>}
            <div className="flex justify-between mt-6">
              <button className="btn-quiet px-4 py-2 text-sm" onClick={() => setStep(2)}>上一步</button>
              <button className="btn-primary px-5 py-2 text-sm flex items-center gap-2" onClick={finish}>
                <Rocket size={14} /> 开始使用
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
