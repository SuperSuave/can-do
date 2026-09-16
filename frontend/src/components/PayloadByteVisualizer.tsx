import React from 'react';

type ByteInput = string | Record<string, string> | undefined;

interface PayloadByteVisualizerProps {
  payload?: ByteInput;
  fromPayload?: ByteInput;
  toPayload?: ByteInput;
  matchPayload?: ByteInput;
  compact?: boolean;
}

export const PayloadByteVisualizer: React.FC<PayloadByteVisualizerProps> = ({
  payload,
  fromPayload,
  toPayload,
  matchPayload,
  compact = false
}) => {
  const parseTokens = (input?: ByteInput): string[] => {
    if (!input) return [];
    if (typeof input === 'object') {
      const keys = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
      return keys.map(k => input[k] ?? '*');
    }
    if (input.trim() === '') return [];
    return input.trim().split(/\s+/);
  };

  const getByteStyle = (token: string) => {
    if (token === '*') {
      return 'bg-slate-800 text-slate-400 border-slate-700/60 font-mono';
    }
    if (token.startsWith('!')) {
      return 'bg-rose-950/50 text-rose-300 border-rose-600/40 font-mono font-semibold';
    }
    if (token.includes('*')) {
      return 'bg-amber-950/40 text-amber-300 border-amber-600/40 font-mono';
    }
    return 'bg-cyan-950/50 text-cyan-300 border-cyan-500/40 font-mono font-semibold';
  };

  const renderByteRow = (tokens: string[], label?: string) => {
    // Pad to up to 8 bytes for visualization
    const displayTokens = [...tokens];
    while (displayTokens.length < 8) {
      displayTokens.push('*');
    }
    const totalCols = 8;

    return (
      <div className="flex flex-col gap-2 w-full pb-1">
        {label && (
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            {label}
          </span>
        )}
        <div className="grid grid-cols-8 gap-1.5 sm:gap-2 items-center w-full pt-1">
          {Array.from({ length: totalCols }).map((_, idx) => {
            const token = displayTokens[idx] !== undefined ? displayTokens[idx] : '*';

            return (
              <div key={idx} className="flex flex-col items-center gap-1">
                <div
                  className={`w-full flex items-center justify-center rounded-lg border ${getByteStyle(
                    token
                  )} transition-colors ${
                    compact
                      ? 'h-8 text-xs font-semibold'
                      : 'h-10 sm:h-11 text-sm font-bold'
                  }`}
                  title={`Byte D${idx + 1}: ${token}`}
                >
                  <span className="font-mono">{token}</span>
                </div>
                <span className="font-mono font-bold text-cyan-300 text-[9px] sm:text-[10px]">
                  D{idx + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Case 1: Transition (from -> to)
  if (fromPayload || toPayload) {
    const fromTokens = parseTokens(fromPayload);
    const toTokens = parseTokens(toPayload);

    return (
      <div className={`flex ${compact ? 'flex-col' : 'flex-col lg:flex-row'} items-start ${compact ? '' : 'lg:items-center'} gap-2 sm:gap-3 bg-slate-950/60 p-2 sm:p-2.5 rounded-lg border border-slate-800 min-w-0`}>
        <div className="flex-1 w-full min-w-0">
          {renderByteRow(fromTokens, 'From (Idle / Off)')}
        </div>
        {!compact && <div className="text-slate-500 font-bold px-1 hidden lg:block">→</div>}
        <div className={`text-slate-500 font-bold py-0.5 ${compact ? 'text-xs text-slate-500' : 'lg:hidden'}`}>↓</div>
        <div className="flex-1 w-full min-w-0">
          {renderByteRow(toTokens, 'To (Active / Trigger)')}
        </div>
      </div>
    );
  }

  // Case 2: Match payload
  if (matchPayload) {
    const matchTokens = parseTokens(matchPayload);
    return (
      <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
        {renderByteRow(matchTokens, 'Match Pattern')}
      </div>
    );
  }

  // Case 3: Single static payload
  if (payload) {
    const tokens = parseTokens(payload);
    return (
      <div className="bg-slate-950/60 p-2.5 rounded-lg border border-slate-800">
        {renderByteRow(tokens, 'TX Payload')}
      </div>
    );
  }

  return (
    <div className="text-xs text-slate-500 italic py-1">
      No raw frame payload defined (virtual command or variable status)
    </div>
  );
};
