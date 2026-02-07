
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Blob, LiveServerMessage } from '@google/genai';
import { TranscriptionEntry, VADConfig, AudioStats } from './types';
import { encode, decode, decodeAudioData } from './services/audioUtils';
import { Visualizer } from './components/Visualizer';

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const REFINEMENT_MODEL = 'gemini-3-flash-preview';

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'error'>('idle');
  const [vadConfig, setVadConfig] = useState<VADConfig>({
    threshold: 0.008, // Slightly more sensitive for better detection
    silenceDuration: 3000, // 3 seconds of silence
  });
  const [audioStats, setAudioStats] = useState<AudioStats>({ rms: 0, isVoiceDetected: false });
  const [silenceProgress, setSilenceProgress] = useState(100);

  // Refs for audio processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isRecordingRef = useRef(false);
  
  const sessionRef = useRef<any>(null);
  const lastVoiceTimeRef = useRef<number>(Date.now());
  const transcriptionRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Audio Output Refs
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Synchronize ref with state
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Auto-scroll effect
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcriptions, currentInput]);

  const refineTextIntoParagraph = async (text: string, id: string) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: REFINEMENT_MODEL,
        contents: `I have a raw, spoken transcript. Polish it into a professional paragraph. Return ONLY the polished paragraph.\n\nTranscript: "${text}"`,
      });
      const refinedText = response.text;
      setTranscriptions(prev => prev.map(t => t.id === id ? { ...t, refinedText } : t));
    } catch (error) {
      console.error("Refinement error:", error);
    }
  };

  const finalizeTranscription = useCallback(() => {
    const finalBuffer = transcriptionRef.current.trim();
    if (finalBuffer) {
      const newId = Math.random().toString(36).substring(2, 11);
      setTranscriptions(prev => [...prev, { id: newId, text: finalBuffer, timestamp: Date.now(), type: 'user' }]);
      refineTextIntoParagraph(finalBuffer, newId);
      transcriptionRef.current = '';
      setCurrentInput('');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current) return;
    
    setIsRecording(false);
    isRecordingRef.current = false;
    setStatus('idle');
    setSilenceProgress(100);
    
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close().catch(console.error);
      outputAudioContextRef.current = null;
    }

    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }

    finalizeTranscription();
  }, [finalizeTranscription]);

  const startRecording = async () => {
    try {
      setStatus('connecting');
      setIsRecording(true);
      isRecordingRef.current = true;
      transcriptionRef.current = '';
      setCurrentInput('');
      lastVoiceTimeRef.current = Date.now();

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      if (inputCtx.state === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();
      
      audioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      nextStartTimeRef.current = 0;

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: "You are a professional scribe. Transcribe the user's audio accurately into text.",
        },
        callbacks: {
          onopen: () => {
            setStatus('listening');
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            sourceNodeRef.current = source;
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              if (!isRecordingRef.current) return;
              
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) {
                sum += inputData[i] * inputData[i];
              }
              const rms = Math.sqrt(sum / inputData.length);
              const now = Date.now();
              const isVoice = rms > vadConfig.threshold;
              
              if (isVoice) lastVoiceTimeRef.current = now;

              const elapsedSilence = now - lastVoiceTimeRef.current;
              const progress = Math.max(0, 100 - (elapsedSilence / vadConfig.silenceDuration) * 100);
              
              setAudioStats({ rms, isVoiceDetected: isVoice });
              setSilenceProgress(progress);

              if (elapsedSilence > vadConfig.silenceDuration) {
                stopRecording();
                return;
              }

              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                int16[i] = inputData[i] * 32768;
              }
              
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };

              // CRITICAL: Always use the resolved session to avoid race conditions
              sessionPromise.then(session => {
                if (isRecordingRef.current) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              transcriptionRef.current += text;
              setCurrentInput(transcriptionRef.current);
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputCtx) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const sourceNode = outputCtx.createBufferSource();
              sourceNode.buffer = audioBuffer;
              sourceNode.connect(outputCtx.destination);
              sourceNode.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(sourceNode);
              sourceNode.onended = () => sourcesRef.current.delete(sourceNode);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.turnComplete && !isRecordingRef.current) {
              finalizeTranscription();
            }
          },
          onerror: (e) => {
            console.error('Session Error:', e);
            setStatus('error');
            stopRecording();
          },
          onclose: () => {
            if (isRecordingRef.current) stopRecording();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error('Recording initialization failed:', err);
      setStatus('error');
      setIsRecording(false);
      isRecordingRef.current = false;
    }
  };

  const handleSave = () => {
    const timestamp = new Date().toLocaleString();
    const header = `GEMINI DICTATE & POLISHED OUTPUT\nGenerated on: ${timestamp}\n${"=".repeat(50)}\n\n`;
    const body = transcriptions.map((t, idx) => {
      let block = `--- BLOCK ${idx + 1} (${new Date(t.timestamp).toLocaleTimeString()}) ---\nRAW:\n${t.text}\nPOLISHED:\n${t.refinedText || '[Processing...]'}\n\n`;
      return block;
    }).join('\n');
    const blob = new Blob([header + body], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Gemini-Dictation-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center selection:bg-indigo-100">
      <header className="w-full max-w-6xl px-6 py-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-200">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-900 leading-none">GEMINI LIVE</h1>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Real-time Scribe & Refiner</p>
          </div>
        </div>

        <div className="flex items-center gap-4 bg-white px-5 py-2.5 rounded-2xl shadow-sm border border-slate-200">
          <Visualizer 
            rms={audioStats.rms} 
            isActive={isRecording} 
            isVoice={audioStats.isVoiceDetected} 
          />
          <div className="h-10 w-px bg-slate-100 mx-1"></div>
          <div className="flex flex-col items-end">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Status</span>
            <span className={`text-xs font-bold ${
              status === 'listening' ? 'text-green-600' :
              status === 'connecting' ? 'text-amber-500' :
              status === 'error' ? 'text-red-500' : 'text-slate-600'
            }`}>
              {status.toUpperCase()}
            </span>
          </div>
        </div>
      </header>

      <main className="w-full max-w-6xl px-6 grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1 pb-12">
        <aside className="lg:col-span-3 space-y-6">
          <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
            <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Engine Controls</h3>
            <div className="space-y-8">
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs font-bold text-slate-700">
                  <span>Sensitivity</span>
                  <span className="text-[10px] text-indigo-600">{(vadConfig.threshold * 1000).toFixed(0)}</span>
                </div>
                <input type="range" min="0.001" max="0.05" step="0.001" value={vadConfig.threshold} onChange={(e) => setVadConfig(prev => ({ ...prev, threshold: parseFloat(e.target.value) }))} className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs font-bold text-slate-700">
                  <span>Auto-Stop</span>
                  <span className="text-[10px] text-indigo-600">{vadConfig.silenceDuration}ms</span>
                </div>
                <input type="range" min="1000" max="10000" step="500" value={vadConfig.silenceDuration} onChange={(e) => setVadConfig(prev => ({ ...prev, silenceDuration: parseInt(e.target.value) }))} className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-indigo-600" />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <button onClick={handleSave} disabled={transcriptions.length === 0} className="w-full group flex items-center justify-between px-6 py-4 bg-white border border-slate-200 text-slate-700 rounded-2xl text-sm font-bold hover:border-indigo-300 transition-all shadow-sm disabled:opacity-50">
              <span>Export</span>
              <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            </button>
            <button onClick={() => setTranscriptions([])} className="w-full py-3 text-[10px] font-black text-slate-400 hover:text-rose-500 uppercase tracking-widest">Clear Session</button>
          </div>
        </aside>

        <div className="lg:col-span-9 flex flex-col min-h-[700px]">
          <div className="flex-1 bg-white rounded-[2.5rem] shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden flex flex-col">
            <div className="px-10 py-6 border-b border-slate-50 flex items-center justify-between bg-white">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-300">Transcription Feed</span>
              {isRecording && (
                <div className="w-32 h-1 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${silenceProgress}%` }} />
                </div>
              )}
            </div>

            <div ref={scrollRef} className="flex-1 p-8 md:p-12 overflow-y-auto space-y-12 bg-gradient-to-b from-white to-slate-50/20">
              {transcriptions.length === 0 && !currentInput && (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 text-center py-20">
                  <h4 className="text-xl font-black text-slate-900 mb-2">Ready to Listen</h4>
                  <p className="text-sm max-w-sm font-medium">Capture your thoughts. Gemini will transcribe them live and then refine them into a polished paragraph.</p>
                </div>
              )}

              {transcriptions.map((entry) => (
                <div key={entry.id} className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                    <div className="md:col-span-4 text-xs text-slate-400 font-medium italic border-l-2 border-slate-100 pl-4">
                      <span className="block mb-2 font-black uppercase tracking-widest text-[9px]">Captured Raw</span>
                      {entry.text}
                    </div>
                    <div className="md:col-span-8 bg-indigo-50/30 p-8 rounded-[2rem] border border-indigo-100/50 relative">
                      <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest block mb-4">Polished Segment</span>
                      {entry.refinedText ? (
                        <p className="text-xl text-slate-800 leading-relaxed font-bold">{entry.refinedText}</p>
                      ) : (
                        <div className="flex gap-2 animate-pulse text-indigo-400 font-bold text-xs uppercase">Gemini is polishing...</div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {currentInput && (
                <div className="py-6 border-t border-slate-50">
                  <p className="text-2xl text-slate-400 leading-tight font-bold italic">
                    {currentInput}
                    <span className="inline-block w-2 h-8 bg-indigo-600 ml-2 animate-pulse opacity-50"></span>
                  </p>
                </div>
              )}
            </div>

            <div className="p-10 bg-white border-t border-slate-100 flex flex-col items-center">
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`w-full max-w-xl py-6 rounded-[2rem] flex items-center justify-center gap-4 text-2xl font-black tracking-tight transition-all active:scale-[0.97] shadow-2xl ${
                  isRecording ? 'bg-rose-500 text-white shadow-rose-200' : 'bg-indigo-600 text-white shadow-indigo-200'
                }`}
              >
                {isRecording ? "FINISH RECORDING" : "START DICTATING"}
              </button>
              <div className="mt-4 flex gap-6 text-[9px] font-black text-slate-400 uppercase tracking-widest">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${audioStats.isVoiceDetected ? 'bg-indigo-600' : 'bg-slate-200'}`}></div>
                  Mic Active
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <footer className="py-8 text-slate-400 text-[9px] font-black uppercase tracking-[0.4em] opacity-40">
        Engineered with Gemini 2.5 Live Protocol
      </footer>
    </div>
  );
};

export default App;
