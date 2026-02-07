import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { ConfigPanel } from './components/ConfigPanel';
import { ScreenViewer } from './components/ScreenViewer';
import { WelcomeScreen } from './components/WelcomeScreen';
import { analyzeScreen } from './services/gemini';
import { processVoiceCommand } from './services/commandHandler';
import { AppState } from './types';

// Simple Audio Service for accessibility beeps
const playSound = (type: 'listen' | 'process' | 'error') => {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === 'listen') {
      // High pitch "ding" - Ready for command
      osc.frequency.setValueAtTime(880, now); // A5
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.1); // A6
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    } else if (type === 'process') {
      // Lower pitch - Processing/Understood
      osc.frequency.setValueAtTime(440, now); // A4
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else {
      // Error buzz
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  } catch (e) {
    console.error("Audio feedback failed", e);
  }
};

function App() {
  const [hasStarted, setHasStarted] = useState(false);
  const [isHandsFree, setIsHandsFree] = useState(false);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [narration, setNarration] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const isHandsFreeRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);

  // Sync refs and manage state transitions for the loop
  useEffect(() => {
    isHandsFreeRef.current = isHandsFree;
    
    // LOOP LOGIC:
    // If we are Hands Free and IDLE, we automatically go to STANDBY to listen for "Start".
    // This happens after the app finishes speaking an answer.
    if (isHandsFree && appState === AppState.IDLE) {
      setAppState(AppState.STANDBY);
      startWakeWordListener();
    } else if (!isHandsFree && appState === AppState.STANDBY) {
      setAppState(AppState.IDLE);
      stopRecognition();
    }
  }, [isHandsFree, appState]);

  const stopRecognition = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch(e) {}
      recognitionRef.current = null;
    }
  };

  const getRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    return recognition;
  };

  // 1. Wake Word Listener (STANDBY state)
  const startWakeWordListener = () => {
    stopRecognition();
    const recognition = getRecognition();
    if (!recognition) return;

    recognition.onend = () => {
      // Auto-restart if we are still in standby and hands-free
      // This keeps the loop alive if no word was detected
      if (isHandsFreeRef.current && appState === AppState.STANDBY) {
        try { recognition.start(); } catch(e) {}
      }
    };

    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript.toLowerCase();
      // Flexible wake words
      if (text.includes("start") || text.includes("agent") || text.includes("computer")) {
        startListeningForQuery();
      }
    };

    try {
      recognitionRef.current = recognition;
      recognition.start();
    } catch (e) {
      console.warn("Wake word start failed", e);
    }
  };

  // 2. Command Listener (LISTENING state)
  const startListeningForQuery = () => {
    stopRecognition();
    const recognition = getRecognition();
    if (!recognition) return;

    playSound('listen'); // Audio feedback: Ready
    setAppState(AppState.LISTENING);

    recognition.onend = () => {
      // If we finished without a result (silence), go back to IDLE 
      // which will trigger STANDBY again
      if (appState === AppState.LISTENING) {
         setAppState(AppState.IDLE);
      }
    };

    recognition.onerror = () => {
      // On error, reset to IDLE -> STANDBY
      setAppState(AppState.IDLE);
    };

    recognition.onresult = async (event: any) => {
      const text = event.results[0][0].transcript;
      setTranscript(text);
      playSound('process'); // Audio feedback: Heard you
      await processRequest(text);
    };

    try {
      recognitionRef.current = recognition;
      recognition.start();
    } catch (e) {
      setAppState(AppState.IDLE);
    }
  };

  // Text to Speech
  const speak = (text: string): Promise<void> => {
    return new Promise((resolve) => {
      synthRef.current.cancel(); // Stop any previous speech

      const utterance = new SpeechSynthesisUtterance(text);
      const voices = synthRef.current.getVoices();
      // Prefer a natural sounding Google voice
      const preferredVoice = voices.find(v => v.name.includes('Google US English')) || voices.find(v => v.lang === 'en-US') || voices[0];
      if (preferredVoice) utterance.voice = preferredVoice;
      
      utterance.rate = 1.1; 

      utterance.onstart = () => setAppState(AppState.SPEAKING);
      
      // CRITICAL: When speaking ends, we go to IDLE.
      // The useEffect above sees IDLE and switches back to STANDBY (listening for "Start").
      utterance.onend = () => {
        setAppState(AppState.IDLE);
        resolve();
      };
      
      utterance.onerror = () => {
        setAppState(AppState.IDLE);
        resolve();
      };

      synthRef.current.speak(utterance);
    });
  };

  // Screen Capture
  const captureScreen = async (): Promise<string> => {
    if (!streamRef.current || !streamRef.current.active) {
       throw new Error("Screen share stream lost.");
    }

    const videoTrack = streamRef.current.getVideoTracks()[0];
    
    // Robust frame capture
    const video = document.createElement('video');
    video.srcObject = streamRef.current;
    video.muted = true;
    video.play();
    
    await new Promise(r => setTimeout(r, 150)); // Ensure frame is rendered
    
    const canvas = document.createElement('canvas');
    canvas.width = videoTrack.getSettings().width || 1920;
    canvas.height = videoTrack.getSettings().height || 1080;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas init failed");
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  };

  // 3. Request Processing Pipeline
  const processRequest = async (prompt: string) => {
    try {
      // STEP 1: Check for Local Commands (Navigation/Search/Settings)
      const commandResult = processVoiceCommand(prompt);
      
      if (commandResult.handled) {
        setNarration(commandResult.message || "Command executed.");
        // Speak the confirmation, then return (skipping screen analysis)
        if (commandResult.message) {
           await speak(commandResult.message);
        }
        // Loop triggers automatically via onend of speak -> IDLE -> STANDBY
        return;
      }

      // STEP 2: AI Screen Analysis (Fallback)
      setAppState(AppState.CAPTURING);
      const base64 = await captureScreen();
      setCapturedImage(base64);

      setAppState(AppState.ANALYZING);
      const text = await analyzeScreen({ 
        imageBase64: base64, 
        width: 1920, 
        height: 1080,
        prompt: prompt 
      });
      
      setNarration(text);
      await speak(text);

    } catch (err: any) {
      console.error(err);
      playSound('error');
      setError("I couldn't complete that request.");
      await speak("Sorry, I had trouble with that request."); 
    }
  };

  // INITIALIZATION
  const handleStartSession = async () => {
    try {
      // 1. Request Screen Share
      // We use 'monitor' to hint the browser to select the whole screen.
      // Note: User still has to click 'Share' due to browser security.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { 
          displaySurface: "monitor", 
          logicalSurface: true,
          cursor: "always" 
        } as any,
        audio: false,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include"
      } as any);
      
      streamRef.current = stream;

      // 2. Request Mic Permission
      const streamMic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamMic.getTracks().forEach(t => t.stop()); 

      setHasStarted(true);
      setIsHandsFree(true); 
      
      // 3. Initial greeting
      await speak("Spatial Agent connected. Say Start to begin.");

    } catch (err) {
      console.error("Setup failed", err);
      const msg = new SpeechSynthesisUtterance("Screen selection failed. Please refresh and make sure to select your entire screen in the dialog.");
      window.speechSynthesis.speak(msg);
    }
  };

  if (!hasStarted) {
    return <WelcomeScreen onStart={handleStartSession} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#0f172a]">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col lg:flex-row gap-8 h-[calc(100vh-8rem)]">
          
          <ConfigPanel 
            isMonitoring={false}
            isHandsFree={isHandsFree}
            onToggleMonitoring={() => {}}
            onToggleHandsFree={() => setIsHandsFree(!isHandsFree)}
            onStartListening={startListeningForQuery}
            appState={appState}
            transcript={transcript}
          />

          <div className="flex-1 flex flex-col gap-4">
            <ScreenViewer 
              imageSrc={capturedImage}
              narration={narration}
              isAnalyzing={appState === AppState.ANALYZING}
              isSpeaking={appState === AppState.SPEAKING}
            />
          </div>

        </div>
      </main>
      
      <div className="sr-only" aria-live="assertive">
        {appState === AppState.LISTENING ? "Listening" : ""}
        {appState === AppState.ANALYZING ? "Analyzing screen" : ""}
        {error}
      </div>
    </div>
  );
}

export default App;