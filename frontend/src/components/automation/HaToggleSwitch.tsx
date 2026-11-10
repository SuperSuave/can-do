import React from 'react';
import { Switch } from '@heroui/react';

export interface HaToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

export const HaToggleSwitch: React.FC<HaToggleSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  ariaLabel = 'Toggle automation state',
  className = ''
}) => {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center ${className}`}
    >
      <Switch
        isSelected={checked}
        onChange={(val) => {
          if (!disabled) {
            onChange(val);
          }
        }}
        isDisabled={disabled}
        size={size}
        aria-label={ariaLabel}
        className="cursor-pointer"
      >
        <Switch.Content>
          <Switch.Control
            className={`transition-colors duration-200 border ${
              checked
                ? '!bg-[#00a8e8] !border-[#0092cc]'
                : '!bg-[#202124] !border-[#3c4043]'
            }`}
          >
            <Switch.Thumb className="!bg-white shadow-sm" />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
};
