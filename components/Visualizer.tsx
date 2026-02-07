
import React from 'react';

interface VisualizerProps {
  rms: number;
  isActive: boolean;
  isVoice: boolean;
}

export const Visualizer: React.FC<VisualizerProps> = ({ rms, isActive, isVoice }) => {
  // Map RMS (usually 0-0.1) to a more visible percentage
  const height = isActive ? Math.min(100, rms * 1000) : 0;
  
  return (
    <div className="flex items-center justify-center gap-1 h-12 w-32 bg-slate-100 rounded-lg overflow-hidden relative">
      <div 
        className={`absolute bottom-0 left-0 right-0 transition-all duration-75 ${
          isVoice ? 'bg-indigo-500' : 'bg-slate-300'
        }`}
        style={{ height: `${height}%`, opacity: 0.4 }}
      />
      {[...Array(5)].map((_, i) => (
        <div 
          key={i}
          className={`w-1 rounded-full transition-all duration-75 ${
            isVoice ? 'bg-indigo-600' : 'bg-slate-400'
          }`}
          style={{ 
            height: isActive ? `${Math.max(10, height * (0.5 + Math.random() * 0.5))}%` : '4px' 
          }}
        />
      ))}
    </div>
  );
};
