import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Info,
  Settings,
  Tag,
  Play,
  Copy,
  ToggleLeft,
  ToggleRight,
  Trash2,
  MoreVertical
} from 'lucide-react';
import { Button } from '@heroui/react';
import { AutomationRule } from '../../types/automation';

export interface AutomationActionMenuProps {
  rule: AutomationRule;
  onToggleEnabled?: (enabled: boolean) => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onRunActions?: () => void;
  onShowTraces?: () => void;
  onMoreInfo?: () => void;
  onEditSettings?: () => void;
  onEditCategory?: () => void;
  buttonSize?: 'sm' | 'md';
  align?: 'left' | 'right';
  className?: string;
}

// Home Assistant styled Trace icon (vertical trunk with 3 circles and branch)
export const TracesIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="8" y1="5" x2="8" y2="19" />
    <circle cx="8" cy="5" r="2.5" fill="currentColor" />
    <circle cx="8" cy="19" r="2.5" fill="currentColor" />
    <path d="M8 12h4a3 3 0 0 1 3 3v4" />
    <circle cx="15" cy="19" r="2.5" fill="currentColor" />
  </svg>
);

export const AutomationActionMenu: React.FC<AutomationActionMenuProps> = ({
  rule,
  onToggleEnabled,
  onDuplicate,
  onDelete,
  onRunActions,
  onShowTraces,
  onMoreInfo,
  onEditSettings,
  onEditCategory,
  buttonSize = 'md',
  align = 'right',
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = spaceBelow < 330 && spaceAbove > spaceBelow;

    const menuWidth = 152;
    let left: number | undefined;
    let right: number | undefined;

    if (align === 'right') {
      right = Math.max(8, window.innerWidth - rect.right);
      if (rect.right < menuWidth + 8) {
        right = undefined;
        left = 8;
      }
    } else {
      left = Math.max(8, rect.left);
      if (left + menuWidth > window.innerWidth - 8) {
        left = undefined;
        right = 8;
      }
    }

    if (openUp) {
      setMenuCoords({
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        left,
        right
      });
    } else {
      setMenuCoords({
        top: Math.max(8, rect.bottom + 6),
        left,
        right
      });
    }
  }, [align]);

  // Position updates and event listeners when open
  useEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const handleScrollOrResize = () => {
      updatePosition();
    };

    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    document.addEventListener('mousedown', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      document.removeEventListener('mousedown', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, updatePosition]);

  const handleToggleOpen = (e?: any) => {
    e?.stopPropagation?.();
    if (!isOpen) {
      updatePosition();
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const handleAction = (action?: () => void) => {
    setIsOpen(false);
    if (action) {
      action();
    }
  };

  const isSm = buttonSize === 'sm';
  const buttonDimensions = isSm ? 'w-7 h-7' : 'w-8 h-8';

  const menuContent = isOpen && menuCoords && (
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      style={{
        width: '152px',
        maxWidth: '152px',
        minWidth: '152px',
        top: menuCoords.top !== undefined ? `${menuCoords.top}px` : undefined,
        bottom: menuCoords.bottom !== undefined ? `${menuCoords.bottom}px` : undefined,
        left: menuCoords.left !== undefined ? `${menuCoords.left}px` : undefined,
        right: menuCoords.right !== undefined ? `${menuCoords.right}px` : undefined,
      }}
      className="fixed z-[9999] w-[152px] max-w-[152px] min-w-[152px] box-border py-1.5 px-1 rounded-xl bg-overlay border border-border shadow-overlay backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 1. More info */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onMoreInfo)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg"
      >
        <Info className="w-4 h-4 text-accent flex-shrink-0 mr-3" />
        <span className="text-[13px] font-semibold text-accent">More info</span>
      </Button>

      {/* 2. Settings */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onEditSettings)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        <Settings className="w-4 h-4 text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-overlay-foreground">Settings</span>
      </Button>

      {/* 3. Edit category */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onEditCategory)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        <Tag className="w-4 h-4 text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-overlay-foreground">Edit category</span>
      </Button>

      {/* 4. Run actions */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onRunActions)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        <Play className="w-4 h-4 fill-current text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-overlay-foreground">Run actions</span>
      </Button>

      {/* 5. Traces */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onShowTraces)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        <TracesIcon className="w-4 h-4 text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-overlay-foreground">Traces</span>
      </Button>

      {/* 6. Duplicate */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onDuplicate)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        <Copy className="w-4 h-4 text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-overlay-foreground">Duplicate</span>
      </Button>

      {/* 7. Disable / Enable */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => {
          handleAction(() => {
            if (onToggleEnabled) onToggleEnabled(!rule.enabled);
          });
        }}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-surface-secondary active:!bg-surface-tertiary transition-colors group cursor-pointer border-0 rounded-lg text-overlay-foreground"
      >
        {rule.enabled ? (
          <ToggleLeft className="w-4 h-4 text-muted group-hover:text-overlay-foreground flex-shrink-0 mr-3" />
        ) : (
          <ToggleRight className="w-4 h-4 text-accent flex-shrink-0 mr-3" />
        )}
        <span className="text-[13px] font-medium text-overlay-foreground">
          {rule.enabled ? 'Disable' : 'Enable'}
        </span>
      </Button>

      {/* 8. Delete */}
      <Button
        variant="ghost"
        size="sm"
        fullWidth
        onPress={() => handleAction(onDelete)}
        className="w-full justify-start px-3 py-2 h-auto text-left whitespace-nowrap hover:!bg-danger-soft active:!bg-danger/25 transition-colors group cursor-pointer border-0 rounded-lg text-danger"
      >
        <Trash2 className="w-4 h-4 text-danger flex-shrink-0 mr-3" />
        <span className="text-[13px] font-medium text-danger">
          Delete
        </span>
      </Button>
    </div>
  );

  return (
    <div className={`relative inline-block text-left ${className}`}>
      {/* 3-dots kebab trigger button using HeroUI Button */}
      <Button
        ref={buttonRef}
        variant="ghost"
        size={isSm ? 'sm' : 'md'}
        isIconOnly
        onPress={handleToggleOpen}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`Actions for automation ${rule.name || rule.id}`}
        className={`!rounded-full flex items-center justify-center transition-colors duration-150 p-0 ${buttonDimensions} ${
          isOpen
            ? '!bg-surface-tertiary text-foreground'
            : '!bg-surface-secondary hover:!bg-surface-tertiary text-muted hover:text-foreground border-0'
        }`}
      >
        <MoreVertical className={isSm ? 'w-4 h-4' : 'w-4 h-4'} />
      </Button>

      {/* Portaled to document.body: on top layer, overlaps outer sidebar containers & cards */}
      {typeof document !== 'undefined' && menuContent ? createPortal(menuContent, document.body) : null}
    </div>
  );
};
