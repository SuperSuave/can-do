import React, { useState } from 'react';
import { AutomationRule, AutomationSettings, AutomationTrigger, AutomationCondition, AutomationAction } from '../types/automation';
import { formatCanId, formatHexByte, compileToByteMap } from '../utils/automationConverters';
import {
  X,
  Upload,
  FileCode,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ArrowRight,
  ClipboardPaste,
  FileJson
} from 'lucide-react';

interface AutomationImportModalProps {
  isOpen: boolean;
  existingRules: AutomationRule[];
  onClose: () => void;
  onImport: (
    importedRules: AutomationRule[],
    mode: 'merge' | 'replace',
    importedSettings?: AutomationSettings
  ) => void;
}

export const AutomationImportModal: React.FC<AutomationImportModalProps> = ({
  isOpen,
  existingRules,
  onClose,
  onImport
}) => {
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parsedRules, setParsedRules] = useState<AutomationRule[] | null>(null);
  const [parsedSettings, setParsedSettings] = useState<AutomationSettings | undefined>();
  const [dragOver, setDragOver] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  if (!isOpen) return null;

  const sanitizeTrigger = (t: any): AutomationTrigger => {
    if (!t || typeof t !== 'object') return t;
    const clone = { ...t };
    if (clone.can_id !== undefined && clone.can_id !== null) {
      clone.can_id = formatCanId(clone.can_id);
    }
    if (clone.from !== undefined && clone.from !== null) {
      clone.from = formatHexByte(clone.from) || clone.from;
    }
    if (clone.to !== undefined && clone.to !== null) {
      clone.to = formatHexByte(clone.to) || clone.to;
    }
    if (clone.mask !== undefined && clone.mask !== null) {
      clone.mask = typeof clone.mask === 'object' ? compileToByteMap(clone.mask) : (formatHexByte(clone.mask) || clone.mask);
    }
    if (clone.match && typeof clone.match === 'object') {
      clone.match = compileToByteMap(clone.match);
    }
    if (clone.to_payload && typeof clone.to_payload === 'object') {
      clone.to_payload = compileToByteMap(clone.to_payload);
    }
    return clone;
  };

  const sanitizeCondition = (c: any): AutomationCondition => {
    if (!c || typeof c !== 'object') return c;
    const clone = { ...c };
    if (clone.can_id !== undefined && clone.can_id !== null) {
      clone.can_id = formatCanId(clone.can_id);
    }
    if (clone.value !== undefined && clone.value !== null) {
      clone.value = formatHexByte(clone.value) || clone.value;
    }
    if (clone.mask !== undefined && clone.mask !== null) {
      clone.mask = typeof clone.mask === 'object' ? compileToByteMap(clone.mask) : (formatHexByte(clone.mask) || clone.mask);
    }
    if (clone.match && typeof clone.match === 'object') {
      clone.match = compileToByteMap(clone.match);
    }
    if (clone.evaluate && typeof clone.evaluate === 'object') {
      clone.evaluate = {
        ...clone.evaluate,
        value: clone.evaluate.value !== undefined ? (formatHexByte(clone.evaluate.value) || clone.evaluate.value) : clone.evaluate.value,
        mask: clone.evaluate.mask !== undefined ? (typeof clone.evaluate.mask === 'object' ? compileToByteMap(clone.evaluate.mask) : (formatHexByte(clone.evaluate.mask) || clone.evaluate.mask)) : clone.evaluate.mask
      };
    }
    if (Array.isArray(clone.conditions)) {
      clone.conditions = clone.conditions.map(sanitizeCondition);
    }
    if (Array.isArray(clone.and)) {
      clone.and = clone.and.map(sanitizeCondition);
    }
    if (Array.isArray(clone.or)) {
      clone.or = clone.or.map(sanitizeCondition);
    }
    if (Array.isArray(clone.not)) {
      clone.not = clone.not.map(sanitizeCondition);
    } else if (clone.not && typeof clone.not === 'object') {
      clone.not = sanitizeCondition(clone.not);
    }
    return clone;
  };

  const sanitizeAction = (a: any): AutomationAction => {
    if (!a || typeof a !== 'object') return a;
    const clone = { ...a };
    if (clone.can_id !== undefined && clone.can_id !== null) {
      clone.can_id = formatCanId(clone.can_id);
    }
    if (clone.payload !== undefined && clone.payload !== null) {
      const c = compileToByteMap(clone.payload);
      if (Object.keys(c).length > 0) clone.payload = c;
    }
    if (Array.isArray(clone.steps)) {
      clone.steps = clone.steps.map((s: any) => {
        if (!s || typeof s !== 'object') return s;
        const sClone = { ...s };
        if (sClone.can_id !== undefined && sClone.can_id !== null) {
          sClone.can_id = formatCanId(sClone.can_id);
        }
        if (sClone.payload !== undefined && sClone.payload !== null) {
          const sc = compileToByteMap(sClone.payload);
          if (Object.keys(sc).length > 0) sClone.payload = sc;
        }
        return sClone;
      });
    }
    if (Array.isArray(clone.choices)) {
      clone.choices = clone.choices.map((ch: any) => ({
        ...ch,
        conditions: Array.isArray(ch.conditions) ? ch.conditions.map(sanitizeCondition) : [],
        sequence: Array.isArray(ch.sequence) ? ch.sequence.map(sanitizeAction) : []
      }));
    }
    if (Array.isArray(clone.default)) {
      clone.default = clone.default.map(sanitizeAction);
    }
    if (Array.isArray(clone.conditions)) {
      clone.conditions = clone.conditions.map(sanitizeCondition);
    }
    if (clone.condition && typeof clone.condition === 'object') {
      clone.condition = sanitizeCondition(clone.condition);
    }
    if (Array.isArray(clone.if)) {
      clone.if = clone.if.map(sanitizeCondition);
    }
    if (Array.isArray(clone.then)) {
      clone.then = clone.then.map(sanitizeAction);
    }
    if (Array.isArray(clone.else)) {
      clone.else = clone.else.map(sanitizeAction);
    }
    if (Array.isArray(clone.sequence)) {
      clone.sequence = clone.sequence.map(sanitizeAction);
    }
    return clone;
  };

  const normalizeImportedRule = (rawRule: any, idx: number): AutomationRule => {
    return {
      id:
        typeof rawRule.id === 'string' && rawRule.id.trim()
          ? rawRule.id.trim()
          : `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${idx}`,
      name:
        typeof rawRule.name === 'string' && rawRule.name.trim()
          ? rawRule.name.trim()
          : `Imported Automation #${idx + 1}`,
      enabled: rawRule.enabled !== undefined ? Boolean(rawRule.enabled) : true,
      ha_expose: rawRule.ha_expose !== undefined ? Boolean(rawRule.ha_expose) : true,
      ha_icon: typeof rawRule.ha_icon === 'string' ? rawRule.ha_icon : 'mdi:car-cog',
      exec_mode: rawRule.exec_mode || 'one_shot',
      trigger_mode: rawRule.trigger_mode || 'any',
      cooldown_ms: Number(rawRule.cooldown_ms) || 0,
      timeout_reset_ms: Number(rawRule.timeout_reset_ms) || 0,
      triggers: Array.isArray(rawRule.triggers) ? rawRule.triggers.map(sanitizeTrigger) : [],
      conditions: Array.isArray(rawRule.conditions) ? rawRule.conditions.map(sanitizeCondition) : [],
      actions: Array.isArray(rawRule.actions) ? rawRule.actions.map(sanitizeAction) : [],
      off_actions: Array.isArray(rawRule.off_actions) ? rawRule.off_actions.map(sanitizeAction) : undefined
    };
  };

  const handleProcessRaw = (raw: string) => {
    setError(null);
    setParsedRules(null);
    setParsedSettings(undefined);
    setConfirmReplace(false);

    if (!raw.trim()) return;

    try {
      const parsed = JSON.parse(raw);
      let detectedRules: AutomationRule[] = [];
      let detectedSettings: AutomationSettings | undefined;

      // Case 1: automations.json format with settings and rules array
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) {
        detectedRules = parsed.rules.map(normalizeImportedRule);
        if (parsed.settings && typeof parsed.settings === 'object') {
          detectedSettings = parsed.settings;
        }
      }
      // Case 2: Full can_do_catalog.json with embedded automations array
      else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.automations)) {
        detectedRules = parsed.automations.map(normalizeImportedRule);
      }
      // Case 3: An array of automation rule objects
      else if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          throw new Error('The pasted array is empty. Please provide at least one automation rule.');
        }
        detectedRules = parsed.map(normalizeImportedRule);
      }
      // Case 4: A single automation rule object
      else if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.triggers || parsed.actions || parsed.name || parsed.exec_mode)
      ) {
        detectedRules = [normalizeImportedRule(parsed, 0)];
      } else {
        throw new Error(
          'Unrecognized automation structure. Expected an automations.json file, a rules array, or a single automation object with triggers/actions.'
        );
      }

      if (detectedRules.length === 0) {
        throw new Error('No valid automation rules could be extracted from this payload.');
      }

      setParsedRules(detectedRules);
      setParsedSettings(detectedSettings);
    } catch (err: any) {
      setError(err.message || 'Invalid JSON syntax.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = event => {
      const content = (event.target?.result as string) || '';
      setJsonText(content);
      handleProcessRaw(content);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = event => {
        const content = (event.target?.result as string) || '';
        setJsonText(content);
        handleProcessRaw(content);
      };
      reader.readAsText(file);
    }
  };

  const handleApply = (mode: 'merge' | 'replace') => {
    if (!parsedRules || parsedRules.length === 0) return;

    if (mode === 'replace') {
      onImport(parsedRules, 'replace', parsedSettings);
      onClose();
      return;
    }

    // Merge: check for ID collisions and re-key duplicates so nothing is lost
    const existingIds = new Set(existingRules.map(r => r.id));
    const mergedList: AutomationRule[] = [...existingRules];

    parsedRules.forEach(rule => {
      let finalRule = { ...rule };
      if (existingIds.has(finalRule.id)) {
        finalRule.id = `${finalRule.id}_copy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        finalRule.name = `${finalRule.name} (Imported)`;
      }
      existingIds.add(finalRule.id);
      mergedList.push(finalRule);
    });

    onImport(mergedList, 'merge', parsedSettings);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto animate-in fade-in">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 text-slate-100 shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-950/60">
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-cyan-400" />
              Import Automations
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Upload an <code className="text-cyan-300">automations.json</code> file or paste a single rule snippet.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 max-h-[75vh] overflow-y-auto space-y-4">
          {/* Drag & Drop or File Select Box */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-5 text-center transition-all ${
              dragOver
                ? 'border-cyan-400 bg-cyan-950/30'
                : 'border-slate-700 hover:border-slate-600 bg-slate-950/40'
            }`}
          >
            <FileJson className="w-8 h-8 mx-auto text-cyan-400 mb-2 opacity-80" />
            <p className="text-sm font-semibold text-slate-200">
              Drag & drop your <span className="text-cyan-400 font-mono">automations.json</span> file here
            </p>
            <p className="text-xs text-slate-500 mt-1 mb-3">or browse from your device</p>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 cursor-pointer transition">
              <Upload className="w-3.5 h-3.5" />
              <span>Select .json file</span>
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {/* Paste JSON Snippet Textarea */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <label htmlFor="import-textarea" className="font-semibold flex items-center gap-1.5">
                <ClipboardPaste className="w-3.5 h-3.5 text-cyan-400" />
                Or Paste JSON Snippet (Full File or Single Automation):
              </label>
              {jsonText && (
                <button
                  type="button"
                  onClick={() => {
                    setJsonText('');
                    setParsedRules(null);
                    setError(null);
                  }}
                  className="text-[11px] text-slate-500 hover:text-slate-300 underline"
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              id="import-textarea"
              rows={5}
              value={jsonText}
              onChange={e => {
                setJsonText(e.target.value);
                handleProcessRaw(e.target.value);
              }}
              placeholder='{\n  "name": "Auto Walkaway Lock",\n  "exec_mode": "one_shot",\n  "triggers": [...],\n  "actions": [...]\n}'
              className="w-full p-3 font-mono text-xs rounded-xl bg-slate-950 border border-slate-800 text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500 resize-y"
              spellCheck={false}
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-bold">Parsing Error</span>
                <p className="text-rose-200/90">{error}</p>
              </div>
            </div>
          )}

          {/* Success / Parsed Summary Preview */}
          {parsedRules && parsedRules.length > 0 && !error && (
            <div className="p-3.5 rounded-xl bg-slate-950/80 border border-cyan-500/40 space-y-2.5 animate-in fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-bold text-white">
                    {parsedRules.length === 1
                      ? '1 Automation Detected'
                      : `${parsedRules.length} Automations Detected`}
                  </span>
                </div>
                {parsedSettings?.vehicle_model && (
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Vehicle: {parsedSettings.vehicle_model}
                  </span>
                )}
              </div>

              {/* Rule list preview */}
              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {parsedRules.map((rule, idx) => (
                  <div
                    key={rule.id || idx}
                    className="flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 flex-shrink-0" />
                      <span className="font-semibold text-slate-200 truncate">
                        {rule.name || `Rule #${idx + 1}`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-400 flex-shrink-0 font-mono">
                      <span>{rule.triggers?.length || 0} trig</span>
                      <span>·</span>
                      <span>{rule.conditions?.length || 0} cond</span>
                      <span>·</span>
                      <span>{rule.actions?.length || 0} act</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
          >
            Cancel
          </button>

          <div className="flex items-center gap-2">
            {/* Replace All button with confirmation safety */}
            {parsedRules && parsedRules.length > 0 && (
              <>
                {!confirmReplace ? (
                  <button
                    type="button"
                    onClick={() => setConfirmReplace(true)}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 border border-rose-900/60 transition"
                    title="Replace all existing automations"
                  >
                    Replace All
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleApply('replace')}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition animate-pulse shadow-md"
                  >
                    Confirm Replace ({existingRules.length} will be wiped)
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleApply('merge')}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition shadow-lg shadow-cyan-950/50"
                >
                  <span>Merge ({parsedRules.length} Rules)</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
