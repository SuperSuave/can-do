import React, { useState } from 'react';
import {
  Modal,
  ModalBackdrop,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
  ModalBody,
  ModalFooter,
  Button
} from '@heroui/react';
import { X, Tag, Check, Sparkles } from 'lucide-react';
import { AutomationRule } from '../../types/automation';

export interface AutomationCategoryModalProps {
  rule: AutomationRule | null;
  isOpen: boolean;
  onClose: () => void;
  onSaveCategory: (ruleId: string, category: string) => void;
}

const PRESET_AUTOMOTIVE_CATEGORIES = [
  'Comfort & Climate',
  'Doors, Access & Security',
  'Cockpit & Controls',
  'Battery & Preconditioning',
  'Convenience & Driving',
  'Lighting & Signals',
  'High Voltage & Charging',
  'Vehicle State & Telematics',
  'Safety & Alerts',
  'Cluster & HUD',
  'Audio & Media'
];

export const AutomationCategoryModal: React.FC<AutomationCategoryModalProps> = ({
  rule,
  isOpen,
  onClose,
  onSaveCategory
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>(rule?.category || '');
  const [customInput, setCustomInput] = useState<string>('');

  // Update internal state when rule changes
  React.useEffect(() => {
    if (rule) {
      setSelectedCategory(rule.category || '');
      setCustomInput('');
    }
  }, [rule]);

  if (!isOpen || !rule) return null;

  const handleApply = (cat: string) => {
    onSaveCategory(rule.id, cat.trim());
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalBackdrop className="bg-backdrop backdrop-blur-sm fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <ModalContainer className="w-full max-w-md">
          <ModalDialog className="bg-overlay border border-border rounded-2xl shadow-overlay overflow-hidden flex flex-col">
            <ModalHeader className="px-5 py-4 border-b border-separator flex items-center justify-between bg-surface">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-accent" />
                <ModalHeading className="text-base font-bold text-foreground">
                  Edit Category
                </ModalHeading>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-lg text-muted hover:text-foreground hover:bg-surface-secondary transition"
                aria-label="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </ModalHeader>

            <ModalBody className="p-5 space-y-4 text-sm text-foreground">
              <p className="text-xs text-muted">
                Assign a category to organize <span className="text-foreground font-semibold">"{rule.name}"</span> across your dashboard and Home Assistant entities.
              </p>

              {/* Preset category chips */}
              <div>
                <label className="block text-xs font-semibold text-muted mb-2">
                  Suggested Categories
                </label>
                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {PRESET_AUTOMOTIVE_CATEGORIES.map((cat) => {
                    const isSelected = selectedCategory.toLowerCase() === cat.toLowerCase();
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setSelectedCategory(cat)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition flex items-center gap-1.5 ${
                          isSelected
                            ? 'bg-accent-soft border-accent text-accent-soft-foreground font-semibold shadow-sm'
                            : 'bg-surface-secondary border-border text-foreground hover:bg-surface-tertiary hover:border-border-secondary'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 text-accent" />}
                        <span>{cat}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom category input */}
              <div className="pt-2 border-t border-separator">
                <label className="block text-xs font-semibold text-muted mb-1.5">
                  Or Custom Category Name
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customInput}
                    onChange={(e) => {
                      setCustomInput(e.target.value);
                      if (e.target.value.trim()) {
                        setSelectedCategory(e.target.value.trim());
                      }
                    }}
                    placeholder="e.g. Winter Driving, Track Day..."
                    className="flex-1 px-3 py-1.5 rounded-xl bg-surface-secondary border border-border text-foreground text-xs focus:outline-none focus:border-accent placeholder:text-field-placeholder"
                  />
                  {selectedCategory && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCategory('');
                        setCustomInput('');
                      }}
                      className="px-2 py-1.5 text-xs text-muted hover:text-foreground transition"
                      title="Clear category"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </ModalBody>

            <ModalFooter className="px-5 py-3 border-t border-separator bg-surface flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onPress={onClose}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-surface-secondary hover:bg-surface-tertiary text-foreground border border-border transition"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onPress={() => handleApply(selectedCategory)}
                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-accent hover:bg-accent-hover text-accent-foreground transition"
              >
                Save Category
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
};
