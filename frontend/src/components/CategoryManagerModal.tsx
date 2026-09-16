import React, { useState, useMemo } from 'react';
import { Catalog, Command } from '../types/catalog';
import {
  X,
  Layers,
  Edit2,
  Check,
  Trash2,
  Merge,
  Plus,
  ArrowRight,
  AlertTriangle,
  FolderPlus,
  Hash
} from 'lucide-react';

interface CategoryManagerModalProps {
  isOpen: boolean;
  catalog: Catalog;
  onClose: () => void;
  onBatchUpdateCategories: (
    updatedCommands: Command[],
    actionDescription: string,
    affectedCommandIds: string[]
  ) => void;
}

export const CategoryManagerModal: React.FC<CategoryManagerModalProps> = ({
  isOpen,
  catalog,
  onClose,
  onBatchUpdateCategories
}) => {
  // Category stats calculation
  const categoryStats = useMemo(() => {
    const map = new Map<string, { count: number; commands: Command[] }>();
    catalog.commands.forEach(cmd => {
      const cat = cmd.category || 'Uncategorized';
      if (!map.has(cat)) {
        map.set(cat, { count: 0, commands: [] });
      }
      const entry = map.get(cat)!;
      entry.count += 1;
      entry.commands.push(cmd);
    });

    return Array.from(map.entries())
      .map(([name, data]) => ({
        name,
        count: data.count,
        commands: data.commands
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog.commands]);

  // Rename state per category: { [catName]: string }
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');

  // Merge state
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string>('');

  // Create new category state
  const [newCatName, setNewCatName] = useState('');
  const [newCatTargetCommands, setNewCatTargetCommands] = useState<string[]>([]);
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // Search filter inside modal
  const [search, setSearch] = useState('');

  // Status feedback toast
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  if (!isOpen) return null;

  const filteredStats = categoryStats.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  // Handlers
  const handleStartRename = (categoryName: string) => {
    setEditingCategory(categoryName);
    setRenameInput(categoryName);
    setMergeSource(null);
  };

  const handleSaveRename = (originalCategory: string) => {
    const trimmed = renameInput.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', message: 'Category name cannot be empty.' });
      return;
    }
    if (trimmed === originalCategory) {
      setEditingCategory(null);
      return;
    }

    const affectedIds: string[] = [];
    const updatedCommands = catalog.commands.map(cmd => {
      if (cmd.category === originalCategory) {
        affectedIds.push(cmd.id);
        return { ...cmd, category: trimmed };
      }
      return cmd;
    });

    onBatchUpdateCategories(
      updatedCommands,
      `Renamed category "${originalCategory}" to "${trimmed}" across ${affectedIds.length} command(s)`,
      affectedIds
    );

    setEditingCategory(null);
    setFeedback({
      type: 'success',
      message: `Successfully renamed "${originalCategory}" to "${trimmed}" (${affectedIds.length} commands updated).`
    });
  };

  const handleStartMerge = (sourceCategory: string) => {
    setMergeSource(sourceCategory);
    setEditingCategory(null);
    // Default target to the first available category that is not source
    const other = categoryStats.find(c => c.name !== sourceCategory);
    setMergeTarget(other ? other.name : '');
  };

  const handleExecuteMerge = () => {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) {
      setFeedback({ type: 'error', message: 'Please select a valid destination category to merge into.' });
      return;
    }

    const affectedIds: string[] = [];
    const updatedCommands = catalog.commands.map(cmd => {
      if (cmd.category === mergeSource) {
        affectedIds.push(cmd.id);
        return { ...cmd, category: mergeTarget };
      }
      return cmd;
    });

    onBatchUpdateCategories(
      updatedCommands,
      `Merged category "${mergeSource}" into "${mergeTarget}" (${affectedIds.length} commands)`,
      affectedIds
    );

    setMergeSource(null);
    setFeedback({
      type: 'success',
      message: `Merged ${affectedIds.length} command(s) from "${mergeSource}" into "${mergeTarget}".`
    });
  };

  const handleCreateAndAssign = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newCatName.trim();
    if (!cleanName) return;

    if (categoryStats.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) {
      setFeedback({ type: 'error', message: `Category "${cleanName}" already exists.` });
      return;
    }

    if (newCatTargetCommands.length === 0) {
      setFeedback({
        type: 'error',
        message: 'Select at least one command to assign to this new category (or use the command editor to set it).'
      });
      return;
    }

    const updatedCommands = catalog.commands.map(cmd => {
      if (newCatTargetCommands.includes(cmd.id)) {
        return { ...cmd, category: cleanName };
      }
      return cmd;
    });

    onBatchUpdateCategories(
      updatedCommands,
      `Created category "${cleanName}" and assigned ${newCatTargetCommands.length} command(s)`,
      newCatTargetCommands
    );

    setNewCatName('');
    setNewCatTargetCommands([]);
    setIsCreatingNew(false);
    setFeedback({
      type: 'success',
      message: `Created category "${cleanName}" with ${newCatTargetCommands.length} command(s).`
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 bg-black/80 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl rounded-[16px] border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-heading)] shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[var(--input-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--md-sys-color-primary)]">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white">Batch Category Manager</h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Rename, merge, reorganize, or create CAN command categories across your entire catalog.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-[var(--md-sys-color-surface-container-high)] transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 max-h-[72vh] overflow-y-auto space-y-5 text-xs">
          {/* Notification banner */}
          {feedback && (
            <div
              className={`p-3 rounded-[12px] border flex items-center justify-between gap-2 ${
                feedback.type === 'success'
                  ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                  : 'bg-rose-950/60 border-rose-800 text-rose-300'
              }`}
            >
              <div className="flex items-center gap-2 text-xs">
                {feedback.type === 'success' ? (
                  <Check className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                )}
                <span>{feedback.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Quick Action Bar: Search + Create New Category Toggle */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <input
              type="text"
              placeholder="Search existing categories..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full sm:w-64 px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[var(--md-sys-color-primary)]"
            />

            <button
              type="button"
              onClick={() => setIsCreatingNew(!isCreatingNew)}
              className="dash-outline-btn inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold shrink-0"
            >
              <FolderPlus className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
              <span>{isCreatingNew ? 'Close New Category Form' : 'Create & Assign New Category'}</span>
            </button>
          </div>

          {/* New Category Form (collapsible) */}
          {isCreatingNew && (
            <form
              onSubmit={handleCreateAndAssign}
              className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-3"
            >
              <div className="flex items-center gap-2 font-bold text-white text-xs">
                <Plus className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                <span>Create New Category</span>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Category Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. ADAS & Driver Assist, Suspension & Lift, Trailer & Towing"
                  value={newCatName}
                  onChange={e => setNewCatName(e.target.value)}
                  className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white text-xs focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Select Commands to Move to this New Category ({newCatTargetCommands.length} selected):
                </label>
                <div className="max-h-40 overflow-y-auto p-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] space-y-1">
                  {catalog.commands.map(cmd => {
                    const isChecked = newCatTargetCommands.includes(cmd.id);
                    return (
                      <label
                        key={cmd.id}
                        className="flex items-center gap-2 p-1.5 rounded hover:bg-white/5 cursor-pointer text-slate-300 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={e => {
                            if (e.target.checked) {
                              setNewCatTargetCommands(prev => [...prev, cmd.id]);
                            } else {
                              setNewCatTargetCommands(prev => prev.filter(id => id !== cmd.id));
                            }
                          }}
                          className="rounded border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--md-sys-color-primary)] focus:ring-0"
                        />
                        <span className="font-semibold text-white">{cmd.name}</span>
                        <span className="font-mono text-[11px] text-slate-400">({cmd.id})</span>
                        <span className="text-[10px] ml-auto px-2 py-0.5 rounded-full bg-[var(--card-bg)] text-slate-400 border border-[var(--border-color)]">
                          {cmd.category}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsCreatingNew(false)}
                  className="dash-outline-btn px-3 py-1.5 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold transition"
                >
                  Create & Reassign
                </button>
              </div>
            </form>
          )}

          {/* Merge panel banner if active */}
          {mergeSource && (
            <div className="p-4 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-indigo-300 font-bold text-xs">
                  <Merge className="w-4 h-4" />
                  <span>Merge Category "{mergeSource}"</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMergeSource(null)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-[var(--text-muted)]">
                All commands currently classified under{' '}
                <code className="text-cyan-300 font-bold">{mergeSource}</code> will be re-tagged to the
                target category below:
              </p>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex-1">
                  <select
                    value={mergeTarget}
                    onChange={e => setMergeTarget(e.target.value)}
                    className="w-full px-3 py-2 rounded-[8px] bg-[var(--input-bg)] border border-[var(--border-color)] text-white text-xs focus:outline-none focus:border-[var(--md-sys-color-primary)]"
                  >
                    <option value="" disabled>
                      Select Destination Category...
                    </option>
                    {categoryStats
                      .filter(c => c.name !== mergeSource)
                      .map(c => (
                        <option key={c.name} value={c.name}>
                          {c.name} ({c.count} commands)
                        </option>
                      ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleExecuteMerge}
                  disabled={!mergeTarget}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 disabled:opacity-50 text-white font-semibold text-xs transition shrink-0"
                >
                  <Check className="w-4 h-4" />
                  Confirm Merge
                </button>
              </div>
            </div>
          )}

          {/* Categories List */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center justify-between px-1">
              <span>Active Categories ({categoryStats.length})</span>
              <span>Command Count</span>
            </div>

            {filteredStats.length === 0 ? (
              <div className="p-8 text-center rounded-[12px] border border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] text-slate-400">
                No categories found matching "{search}"
              </div>
            ) : (
              filteredStats.map(cat => {
                const isEditingThis = editingCategory === cat.name;

                return (
                  <div
                    key={cat.name}
                    className="p-3.5 rounded-[12px] bg-[var(--md-sys-color-surface-container-low)] border border-[var(--border-color)] hover:border-slate-600 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    {/* Left: Category info or edit input */}
                    <div className="flex-1">
                      {isEditingThis ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={renameInput}
                            onChange={e => setRenameInput(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleSaveRename(cat.name);
                              } else if (e.key === 'Escape') {
                                setEditingCategory(null);
                              }
                            }}
                            autoFocus
                            className="flex-1 px-2.5 py-1.5 rounded-[8px] bg-[var(--input-bg)] border border-[var(--md-sys-color-primary)] text-white text-xs font-semibold focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveRename(cat.name)}
                            className="p-1.5 rounded-full bg-[var(--md-sys-color-primary)] text-white hover:opacity-90 transition"
                            title="Save new category name"
                          >
                            <Check className="w-4 h-4 stroke-[2.5]" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCategory(null)}
                            className="p-1.5 rounded-full bg-slate-800 text-slate-400 hover:text-white transition"
                            title="Cancel rename"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-sm">{cat.name}</span>
                          <span className="px-2 py-0.5 rounded-full bg-[var(--input-bg)] text-slate-400 border border-[var(--border-color)] text-[11px] font-mono">
                            {cat.count} {cat.count === 1 ? 'command' : 'commands'}
                          </span>
                        </div>
                      )}

                      {/* Commands sample badges */}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {cat.commands.slice(0, 4).map(c => (
                          <span
                            key={c.id}
                            className="px-2 py-0.5 rounded-full bg-[var(--input-bg)] text-slate-400 border border-[var(--border-color)] text-[10px] font-mono truncate max-w-[140px]"
                            title={c.name}
                          >
                            {c.name}
                          </span>
                        ))}
                        {cat.commands.length > 4 && (
                          <span className="text-[10px] text-slate-500 px-1 py-0.5">
                            +{cat.commands.length - 4} more
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Right: Actions */}
                    {!isEditingThis && (
                      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                        <button
                          type="button"
                          onClick={() => handleStartRename(cat.name)}
                          className="dash-outline-btn inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold"
                          title={`Rename "${cat.name}" across all ${cat.count} commands`}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                          <span>Rename</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStartMerge(cat.name)}
                          className="dash-outline-btn inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold"
                          title={`Merge "${cat.name}" into another category`}
                        >
                          <Merge className="w-3.5 h-3.5" />
                          <span>Merge</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--border-color)] bg-[var(--md-sys-color-surface-container-low)] flex items-center justify-between">
          <div className="text-[11px] text-[var(--text-muted)]">
            Changes are saved immediately and marked as draft updates ready for GitHub contribution.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-full bg-[var(--md-sys-color-primary)] hover:opacity-90 text-white font-semibold text-xs transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
