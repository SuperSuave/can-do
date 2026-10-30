import React, { useState, useRef } from 'react';
import { AutomationRule } from '../../types/automation';
import { CopyPlus, Trash2, Code, Check } from 'lucide-react';

export interface SwipeableRuleItemProps {
  rule: AutomationRule;
  idx: number;
  isSelected: boolean;
  isSelectMode: boolean;
  isCheckedForDelete: boolean;
  onToggleCheck: (id: string) => void;
  onSelect: (id: string) => void;
  onDuplicate: (rule: AutomationRule) => void;
  onDelete: (id: string) => void;
}

export const SwipeableRuleItem: React.FC<SwipeableRuleItemProps> = ({
  rule,
  idx,
  isSelected,
  isSelectMode,
  isCheckedForDelete,
  onToggleCheck,
  onSelect,
  onDuplicate,
  onDelete
}) => {
  const [dragOffset, setDragOffset] = useState(0);
  const [copiedRuleJson, setCopiedRuleJson] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const swipingRef = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isSelectMode) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    };
    isDraggingRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || isSelectMode) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;

    if (!isDraggingRef.current && Math.abs(dy) > Math.abs(dx)) {
      return;
    }

    if (Math.abs(dx) > 10) {
      isDraggingRef.current = true;
      swipingRef.current = true;
      const clamped = Math.max(-90, Math.min(90, dx));
      setDragOffset(clamped);
    }
  };

  const handleTouchEnd = () => {
    if (!isDraggingRef.current) {
      touchStartRef.current = null;
      return;
    }

    if (dragOffset < -55) {
      setDragOffset(-80);
    } else if (dragOffset > 55) {
      setDragOffset(0);
      onDuplicate(rule);
    } else {
      setDragOffset(0);
    }

    touchStartRef.current = null;
    isDraggingRef.current = false;
    setTimeout(() => {
      swipingRef.current = false;
    }, 50);
  };

  const handleClick = () => {
    if (swipingRef.current) return;
    if (isSelectMode) {
      onToggleCheck(rule.id);
    } else {
      if (dragOffset !== 0) {
        setDragOffset(0);
      } else {
        onSelect(rule.id);
      }
    }
  };

  const handleCopyRuleJson = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(rule, null, 2));
      setCopiedRuleJson(true);
      setTimeout(() => setCopiedRuleJson(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl select-none group">
      {/* Background Action Buttons revealed by swipe */}
      <div className="absolute inset-0 flex items-center justify-between px-2 bg-slate-900/90 rounded-xl">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDragOffset(0);
            onDuplicate(rule);
          }}
          className="h-full px-3.5 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-white flex items-center gap-1.5 text-xs font-bold transition shadow-inner"
          title="Duplicate automation"
        >
          <CopyPlus className="w-4 h-4" />
          <span className="text-[11px] font-semibold">Duplicate</span>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setDragOffset(0);
            onDelete(rule.id);
          }}
          className="h-full px-3.5 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white flex items-center gap-1.5 text-xs font-bold transition ml-auto shadow-inner"
          title="Delete automation"
        >
          <Trash2 className="w-4 h-4" />
          <span className="text-[11px] font-semibold">Delete</span>
        </button>
      </div>

      {/* Foreground Swipeable Card */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
        style={{
          transform: `translateX(${dragOffset}px)`,
          transition: isDraggingRef.current ? 'none' : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
        className={`relative z-10 p-2.5 rounded-xl cursor-pointer border text-left flex flex-col gap-1.5 transition-colors ${
          isSelected
            ? 'bg-slate-800 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-white'
            : 'bg-slate-950/90 border-slate-800 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'
        }`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {isSelectMode ? (
              <input
                type="checkbox"
                checked={isCheckedForDelete}
                onChange={() => onToggleCheck(rule.id)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 rounded text-rose-500 bg-slate-800 border-slate-700 focus:ring-rose-400 cursor-pointer flex-shrink-0"
              />
            ) : (
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  rule.enabled ? 'bg-emerald-400' : 'bg-slate-600'
                }`}
              />
            )}
            <span className="text-xs font-semibold truncate">{rule.name || `Rule #${idx + 1}`}</span>
          </div>

          {!isSelectMode && (
            <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition flex-shrink-0">
              <button
                type="button"
                onClick={handleCopyRuleJson}
                title={copiedRuleJson ? 'Copied JSON to clipboard!' : 'Copy rule JSON'}
                className={`p-1.5 rounded-lg transition ${
                  copiedRuleJson
                    ? 'text-emerald-400 bg-emerald-950/60'
                    : 'text-slate-400 hover:text-cyan-300 hover:bg-slate-700/60 active:bg-slate-700'
                }`}
              >
                {copiedRuleJson ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Code className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDuplicate(rule);
                }}
                title="Duplicate rule in list"
                className="p-1.5 hover:text-cyan-300 text-slate-400 hover:bg-slate-700/60 active:bg-slate-700 rounded-lg transition"
              >
                <CopyPlus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onDelete(rule.id);
                }}
                title="Delete rule"
                className="p-1.5 hover:text-rose-400 text-slate-400 hover:bg-rose-500/10 active:bg-rose-500/20 rounded-lg transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
          {rule.ha_expose && (
            <span className="px-1 py-0.5 rounded bg-orange-950/60 text-orange-300 border border-orange-800/40">
              HA
            </span>
          )}
          <span>
            {(rule.triggers || []).length}T · {(rule.conditions || []).length}C · {(rule.actions || []).length}A
          </span>
          {rule.cooldown_ms ? (
            <span className="text-slate-500">
              {rule.cooldown_ms}ms CD
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

