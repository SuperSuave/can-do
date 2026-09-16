import React, { useState, useRef, useEffect } from 'react';
import {
  Download,
  FileCode,
  FileJson,
  ChevronDown,
  Sparkles,
  Sliders
} from 'lucide-react';
import { ExportFormat } from './ExportModal';

interface ExportDropdownProps {
  onQuickDownloadJson: () => void;
  onOpenExportModal: (format?: ExportFormat) => void;
  variant?: 'navbar' | 'toolbar';
}

export const ExportDropdown: React.FC<ExportDropdownProps> = ({
  onQuickDownloadJson,
  onOpenExportModal,
  variant = 'toolbar'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape key
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const buttonClasses =
    variant === 'navbar'
      ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 transition select-none'
      : 'dash-outline-btn inline-flex items-center gap-1.5 text-xs py-1.5 px-3.5 select-none';

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={buttonClasses}
        aria-expanded={isOpen}
        aria-haspopup="true"
        title="Export catalog as JSON or Vector CAN DBC"
      >
        <Download className="w-3.5 h-3.5 text-slate-300" />
        <span>Export</span>
        <ChevronDown
          className={`w-3 h-3 text-slate-400 transition-transform duration-150 ${
            isOpen ? 'rotate-180 text-cyan-400' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1.5 w-72 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] shadow-2xl z-50 overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-100">
          <div className="px-3 py-2 border-b border-slate-800/80 bg-slate-950/40">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Export Catalog
            </p>
          </div>

          <div className="p-1 space-y-0.5">
            {/* 1. Quick Download JSON */}
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onQuickDownloadJson();
              }}
              className="w-full text-left flex items-start gap-2.5 p-2.5 rounded-lg hover:bg-slate-800/70 transition group"
            >
              <div className="w-7 h-7 rounded-md bg-emerald-950/60 border border-emerald-800/70 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5 group-hover:border-emerald-500 transition">
                <FileJson className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white group-hover:text-emerald-300 transition flex items-center gap-1.5">
                  <span>Download JSON (.json)</span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                    Instant
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                  Full CAN Do hub catalog with vehicles, masks & options
                </p>
              </div>
            </button>

            {/* 2. Export Vector DBC */}
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenExportModal('dbc');
              }}
              className="w-full text-left flex items-start gap-2.5 p-2.5 rounded-lg hover:bg-slate-800/70 transition group"
            >
              <div className="w-7 h-7 rounded-md bg-cyan-950/60 border border-cyan-800/70 flex items-center justify-center text-cyan-400 shrink-0 mt-0.5 group-hover:border-cyan-500 transition">
                <FileCode className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white group-hover:text-cyan-300 transition flex items-center gap-1.5">
                  <span>Vector CAN DBC (.dbc)</span>
                  <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                    Standard
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                  For SavvyCAN, comma.ai / opendbc, Wireshark & cantools
                </p>
              </div>
            </button>
          </div>

          <div className="border-t border-slate-800/80 p-1 bg-slate-950/20">
            {/* 3. Advanced Export Dialog */}
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                onOpenExportModal();
              }}
              className="w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-800/70 text-slate-300 hover:text-white transition text-xs font-medium"
            >
              <Sliders className="w-3.5 h-3.5 text-slate-400" />
              <span>Advanced Export Dialog & Preview...</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
