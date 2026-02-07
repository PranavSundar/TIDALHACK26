
export interface TranscriptionEntry {
  id: string;
  text: string;
  refinedText?: string;
  timestamp: number;
  type: 'user' | 'model';
}

export interface VADConfig {
  threshold: number; // RMS energy threshold (0 to 1)
  silenceDuration: number; // milliseconds of silence before auto-stop
}

export interface AudioStats {
  rms: number;
  isVoiceDetected: boolean;
}
