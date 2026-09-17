import React, { useState } from 'react';

interface PayloadByteEditorProps {
  value?: string | Record<string, string>;
  onChange: (newValue: string) => void;
  label?: string;
  placeholder?: string;
}

export const PayloadByteEditor: React.FC<PayloadByteEditorProps> = ({
  value,
  onChange,
  label
}) => {
  const [isAdvanced, setIsAdvanced] = useState(false);

  // Parse current value into 8 tokens (D1..D8)
  const parseTokens = (input?: string | Record<string, string>): string[] => {
    if (!input) return Array(8).fill('*');
    if (typeof input === 'object') {
      const keys = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
      return keys.map(k => (input[k] !== undefined && input[k] !== '' ? String(input[k]) : '*'));
    }
    const str = typeof input === 'string' ? input : String(input);
    const tokens = str.trim() !== '' ? str.trim().split(/\s+/) : [];
    const result: string[] = [];
    for (let i = 0; i < 8; i++) {
      result.push(tokens[i] !== undefined && tokens[i] !== '' ? tokens[i] : '*');
    }
    return result;
  };

  const tokens = parseTokens(value);

  const handleByteChange = (index: number, val: string) => {
    const newTokens = [...tokens];
    // Clean up input: uppercase, take first word or token
    const cleaned = val.trim().toUpperCase().split(/\s+/)[0] || '*';
    newTokens[index] = cleaned === '' ? '*' : cleaned;
    
    // Build space-separated string
    onChange(newTokens.join(' '));
  };

  const handleClear = () => {
    onChange('* * * * * * * *');
  };

  return (
    <div className="space-y-2 p-3 rounded-xl bg-slate-950/60 border border-slate-800">
      <div className="flex items-center justify-between">
        {label && (
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            {label}
          </span>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="text-[10px] text-slate-400 hover:text-slate-200 underline"
          >
            Reset all to *
          </button>
          <button
            type="button"
            onClick={() => setIsAdvanced(!isAdvanced)}
            className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-800 hover:bg-cyan-900 transition"
          >
            {isAdvanced ? 'Switch to D1–D8 Boxes' : 'Switch to Raw Text'}
          </button>
        </div>
      </div>

      {isAdvanced ? (
        <div className="space-y-1.5">
          <input
            type="text"
            value={typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}:${v}`).join(' ') : (value || '')}
            onChange={e => onChange(e.target.value)}
            placeholder="e.g. * * * * * F8 * *"
            className="w-full px-3 py-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-sm text-cyan-300 focus:outline-none focus:border-cyan-500"
          />
          <p className="text-[10px] text-slate-500">
            Enter space-separated hex bytes or wildcards (<code className="text-amber-300">*</code>).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-8 gap-1 sm:gap-1.5 w-full py-0.5">
          {tokens.map((token, idx) => (
            <div key={idx} className="flex flex-col items-center gap-1">
              <span className="text-[10px] font-mono font-bold text-cyan-400/90">
                D{idx + 1}
              </span>
              <input
                type="text"
                value={token === '*' ? '' : token}
                onChange={e => handleByteChange(idx, e.target.value)}
                placeholder="*"
                maxLength={4}
                title={`Byte D${idx + 1} (leave empty for *)`}
                className={`w-full text-center px-1 py-1.5 rounded-lg font-mono text-xs uppercase transition border focus:outline-none ${
                  token !== '*' && token !== ''
                    ? 'bg-cyan-950/80 text-cyan-300 border-cyan-600 font-semibold'
                    : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-700 placeholder-slate-700'
                }`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
