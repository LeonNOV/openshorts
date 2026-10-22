import React, { useState, useEffect, useRef } from 'react';
import { Check, X, Loader2, KeyRound, Cpu, ShieldCheck, Rocket, Download } from 'lucide-react';
import { apiJson } from '../lib/api';
import { setSecret } from '../lib/secrets';

// First-run wizard (plan §6.3): self-check → API keys → model size.
// Renders as a full-screen overlay above the app until the user finishes.
//
// The installer no longer ships the model weights, so the self-check can find
// them missing. The wizard then offers to download them, with progress, and
// the model-size step lists what can be downloaded instead of what is bundled.
export default function FirstRunWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [selfcheck, setSelfcheck] = useState(null);
  const [checking, setChecking] = useState(true);
  const [whisperSizes, setWhisperSizes] = useState([]);
  const [selectedSize, setSelectedSize] = useState('small');

  const [modelStatus, setModelStatus] = useState(null);
  const [download, setDownload] = useState(null); // { state, downloaded, total, label, error }
  const [downloading, setDownloading] = useState(false);
  const pollRef = useRef(null);

  const [geminiKey, setGeminiKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [voiceKey, setVoiceKey] = useState('');
  const [voiceProvider, setVoiceProvider] = useState('elevenlabs');
  const [error, setError] = useState('');

  const refreshSelfcheck = async () => {
    const sc = await apiJson('/api/selfcheck');
    setSelfcheck(sc);
    return sc;
  };

  useEffect(() => {
    (async () => {
      try {
        const sc = await refreshSelfcheck();
        const sizes = sc.whisper_sizes_available || [];
        setWhisperSizes(sizes);
        if (sizes.length) setSelectedSize(sizes[0]);
        const ms = await apiJson('/api/models');
        setModelStatus(ms);
        if (ms?.whisper?.available?.length && !sizes.length) {
          setSelectedSize(ms.whisper.available[0]);
        }
      } catch (e) {
        setSelfcheck({ ok: false, checks: {}, error: String(e) });
      } finally {
        setChecking(false);
      }
    })();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Poll the download while one is running.
  useEffect(() => {
    if (!downloading) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const p = await apiJson('/api/models/progress');
        setDownload(p);
        if (p.state === 'done' || p.state === 'error') {
          setDownloading(false);
          const sc = await refreshSelfcheck();
          const sizes = sc.whisper_sizes_available || [];
          setWhisperSizes(sizes);
          const ms = await apiJson('/api/models');
          setModelStatus(ms);
        }
      } catch (e) {
        setDownloading(false);
        setDownload({ state: 'error', error: String(e) });
      }
    }, 700);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [downloading]);

  const startDownload = async (size) => {
    setError('');
    setDownload({ state: 'running', downloaded: 0, total: null, label: '' });
    setDownloading(true);
    try {
      await apiJson('/api/models/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size }),
      });
    } catch (e) {
      setDownloading(false);
      setDownload({ state: 'error', error: String(e) });
    }
  };

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

  // The weights are no longer bundled, so a missing model is a "not yet
  // downloaded" state, not a broken installation.
  const modelsReady = !!checks.whisper_model?.ok && !!checks.yolo?.ok;
  const otherChecksOk = ['ffmpeg', 'data_dir_writable', 'python_deps']
    .every((k) => checks[k]?.ok);
  const step1Valid = modelsReady && otherChecksOk;

  const downloadPct = (() => {
    if (!download) return 0;
    if (download.state === 'done') return 100;
    if (!download.total) return 0;
    return Math.min(99, Math.round((download.downloaded / download.total) * 100));
  })();

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
                <CheckRow ok={!!checks.whisper_model?.ok} label="Whisper 模型" detail={checks.whisper_model?.ok ? checks.whisper_model?.path : '尚未下载'} />
                <CheckRow ok={!!checks.yolo?.ok} label="YOLO 权重" detail={checks.yolo?.ok ? checks.yolo?.path : '尚未下载'} />
                <CheckRow ok={!!checks.data_dir_writable?.ok} label="数据目录可写" detail={checks.data_dir_writable?.path} />
                <CheckRow ok={!!checks.python_deps?.ok} label="Python 依赖" detail={checks.python_deps?.missing?.length ? `缺少: ${checks.python_deps.missing.join(', ')}` : '齐全'} />
              </div>
            )}

            {!modelsReady && !checking && (
              <div className="mt-4 border border-rule rounded-input p-3 bg-paper3/40">
                <div className="text-sm text-ink mb-1">安装包不内置模型，首次使用需下载一次</div>
                <div className="text-xs text-muted mb-3 leading-relaxed">
                  Whisper 约 {modelStatus?.whisper?.approximate_mb?.[selectedSize] || 464} MB + YOLO 约 6 MB，
                  下载后保存在本机，之后离线可用。
                  {modelStatus?.base_url && (
                    <> 来源：<span className="break-all">{modelStatus.base_url}</span></>
                  )}
                </div>
                {downloading ? (
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted mb-1">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="animate-spin" size={13} />
                        {download?.label ? `下载 ${download.label}` : '下载中…'}
                      </span>
                      <span>{downloadPct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-rule overflow-hidden">
                      <div className="h-full bg-brass transition-all" style={{ width: `${downloadPct}%` }} />
                    </div>
                  </div>
                ) : (
                  <button className="btn-primary px-4 py-2 text-sm flex items-center gap-2" onClick={() => startDownload(selectedSize)}>
                    <Download size={14} /> 下载模型
                  </button>
                )}
                {download?.state === 'error' && (
                  <p className="text-xs text-red-600 mt-2">下载失败：{download.error}</p>
                )}
                {download?.state === 'done' && (
                  <p className="text-xs text-green-600 mt-2">模型已就绪。</p>
                )}
              </div>
            )}

            <div className="flex justify-end mt-6">
              <button className="btn-primary px-5 py-2 text-sm" disabled={!step1Valid} onClick={() => setStep(2)}>
                下一步
              </button>
            </div>
            {!step1Valid && !checking && (
              <p className="text-xs text-red-600 mt-2">
                {modelsReady ? '自检未全部通过，请检查上方可定位缺失项后再继续。' : '请先下载模型，其余项自检通过后即可继续。'}
              </p>
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
              体积越大识别越准、越慢。已下载的模型会标注「已就绪」，其余会在使用时下载。可在设置中随时更改。
            </p>
            <div className="space-y-2">
              {(() => {
                // Offer what is on disk plus everything that can be fetched.
                const ready = new Set(whisperSizes);
                const available = modelStatus?.whisper?.available || ['small'];
                const options = Array.from(new Set([...whisperSizes, ...available]));
                if (options.length === 0) {
                  return <div className="text-sm text-muted">未检测到可用的模型。</div>;
                }
                return options.map((s) => {
                  const isReady = ready.has(s);
                  const approx = modelStatus?.whisper?.approximate_mb?.[s] || (s === 'small' ? 464 : s === 'medium' ? 1530 : 1620);
                  return (
                    <label key={s} className={`flex items-center gap-3 border rounded-input px-3 py-2 cursor-pointer ${selectedSize === s ? 'border-brass bg-paper3/50' : 'border-rule'}`}>
                      <input type="radio" name="wsize" checked={selectedSize === s} onChange={() => setSelectedSize(s)} />
                      <div className="flex-1">
                        <div className="text-sm text-ink">{s}</div>
                        <div className="text-xs text-muted">~{approx} MB{isReady ? ' · 已就绪' : ''}</div>
                      </div>
                    </label>
                  );
                });
              })()}
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
