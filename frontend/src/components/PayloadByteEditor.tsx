import React, { useState } from 'react';
import { Tabs } from '@heroui/react';

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
      if ('hex' in input && typeof input.hex === 'string') {
        const clean = input.hex.replace(/\s+/g, '').replace(/^0x/i, '');
        const bytes: string[] = [];
        for (let i = 0; i < clean.length; i += 2) {
          bytes.push('0x' + clean.slice(i, i + 2).toUpperCase());
        }
        while (bytes.length < 8) bytes.push('*');
        return bytes.slice(0, 8);
      }
      const keys = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
      return keys.map(k => (input[k] !== undefined && input[k] !== '' ? String(input[k]) : '*'));
    }
    const str = typeof input === 'string' ? input : String(input);
    const trimmed = str.trim();
    const noPrefix = trimmed.replace(/^0x/i, '');
    let tokens: string[] = [];
    if (/^[0-9a-fA-F]{4,16}$/.test(noPrefix) && noPrefix.length % 2 === 0 && !trimmed.includes(' ')) {
      for (let i = 0; i < noPrefix.length && tokens.length < 8; i += 2) {
        tokens.push('0x' + noPrefix.slice(i, i + 2).toUpperCase());
      }
    } else if (trimmed !== '') {
      tokens = trimmed.split(/\s+/);
    }
    const result: string[] = [];
    for (let i = 0; i < 8; i++) {
      result.push(tokens[i] !== undefined && tokens[i] !== '' ? tokens[i] : '*');
    }
    return result;
  };

  const tokens = parseTokens(value);

  const handleByteChange = (index: number, val: string) => {
    const newTokens = [...tokens];
    let cleaned = val.trim().split(/\s+/)[0] || '*';
    if (cleaned !== '*' && cleaned !== '') {
      if (cleaned.toLowerCase().startsWith('0x')) {
        cleaned = `0x${cleaned.slice(2).toUpperCase()}`;
      } else {
        cleaned = cleaned.toUpperCase();
      }
    }
    newTokens[index] = cleaned === '' ? '*' : cleaned;
    
    // Build space-separated string
    onChange(newTokens.join(' '));
  };

  const handleClear = () => {
    onChange('* * * * * * * *');
  };

  return (
    <div className="space-y-2 p-3 rounded-xl bg-surface-secondary border border-border">
      <div className="flex items-center justify-between">
        {label && (
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
            {label}
          </span>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="text-[10px] text-muted hover:text-foreground underline"
          >
            Reset all to *
          </button>
          <Tabs
            selectedKey={isAdvanced ? 'raw' : 'boxes'}
            onSelectionChange={key => setIsAdvanced(key === 'raw')}
            aria-label="Payload Representation Mode"
          >
            <Tabs.ListContainer className="p-0.5 rounded-lg bg-surface-tertiary border border-border text-[10px]">
              <Tabs.List className="gap-0.5">
                <Tabs.Tab
                  id="boxes"
                  className={`relative px-2 py-0.5 rounded font-mono transition cursor-pointer flex items-center ${
                    !isAdvanced
                      ? 'text-accent-soft-foreground font-semibold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>D1–D8 Boxes</span>
                  <Tabs.Indicator className="rounded bg-accent-soft border border-accent/30 shadow-sm" />
                </Tabs.Tab>

                <Tabs.Tab
                  id="raw"
                  className={`relative px-2 py-0.5 rounded font-mono transition cursor-pointer flex items-center ${
                    isAdvanced
                      ? 'text-accent-soft-foreground font-semibold'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  <span>Raw Text</span>
                  <Tabs.Indicator className="rounded bg-accent-soft border border-accent/30 shadow-sm" />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>
      </div>

      {isAdvanced ? (
        <div className="space-y-1.5">
          <input
            type="text"
            value={typeof value === 'object' ? Object.entries(value).map(([k, v]) => `${k}:${v}`).join(' ') : (value || '')}
            onChange={e => onChange(e.target.value)}
            placeholder="e.g. * * * * * F8 * *"
            className="w-full px-3 py-2 rounded-lg bg-surface-tertiary border border-border font-mono text-sm text-accent focus:outline-none focus:border-focus"
          />
          <p className="text-[10px] text-muted">
            Enter space-separated hex bytes or wildcards (<code className="text-warning">*</code>).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-8 gap-1 sm:gap-1.5 w-full py-0.5">
          {tokens.map((token, idx) => (
            <div key={idx} className="flex flex-col items-center gap-1">
              <span className="text-[10px] font-mono font-bold text-accent">
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
                    ? 'bg-accent-soft text-accent-soft-foreground border-accent/60 font-semibold'
                    : 'bg-surface-tertiary text-muted border-border hover:border-border-secondary placeholder:text-muted/60'
                }`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
