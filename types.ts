export enum AppState {
  IDLE = 'IDLE',
  CAPTURING = 'CAPTURING',
  ANALYZING = 'ANALYZING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR',
  LISTENING = 'LISTENING',
  STANDBY = 'STANDBY'
}

export interface AnalysisRequest {
  imageBase64: string;
  width: number;
  height: number;
  prompt?: string;
}