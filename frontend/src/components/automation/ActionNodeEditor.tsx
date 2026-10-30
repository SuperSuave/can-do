import React, { useState, useContext } from 'react';
import {
  Play,
  ArrowUp,
  ArrowDown,
  Copy,
  ClipboardCopy,
  Trash2,
  ChevronDown,
  ChevronUp,
  GitFork,
  Split,
  Plus,
  ClipboardPaste,
  Clock,
  Sliders,
  RotateCw,
  Layers
} from 'lucide-react';
import { AutomationAction, AutomationCondition, AutomationTrigger, AutomationActionStep, ChoiceBranch } from '../../types/automation';
import { Catalog, CommandOption, ByteMap } from '../../types/catalog';
import {
  resolveCatalogCommandForAction,
  applyOptionToAction,
  formatCanId,
  regenerateBranchIds,
  compileToByteMap,
  regenerateActionIds
} from '../../utils/automationConverters';
import {
  groupOptionsIntoGridRows,
  OptionGridGroup,
  LiveWifiStatus,
  LiveBleItem
} from './liveEvaluator';
import { ConditionListEditor } from './ConditionNodeEditor';
import { AutomationClipboardContext } from './AutomationClipboardContext';

export interface ActionNodeEditorProps {
  key?: React.Key;
  act: AutomationAction;
  index: number;
  depth?: number;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (updated: AutomationAction) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
}

export interface ActionListEditorProps {
  actions: AutomationAction[];
  depth?: number;
  label?: string;
  emptyText?: string;
  availableTriggers?: AutomationTrigger[];
  catalog?: Catalog;
  liveFrames?: Map<string, { data: string }>;
  entityStates?: Map<string, string>;
  lastFiredTriggerId?: string;
  liveWifiStatus?: LiveWifiStatus | null;
  liveBleMap?: Map<string, LiveBleItem>;
  onUpdate: (actions: AutomationAction[]) => void;
  onPullCatalog?: () => void;
  onOpenAddConditionDialog?: (onAdd: (cond: AutomationCondition) => void) => void;
  onOpenAddActionDialog?: (onAdd: (act: AutomationAction) => void) => void;
  onTestSingleAction?: (act: AutomationAction) => void;
}

export function ActionNodeEditor({
  act,
  index,
  depth = 0,
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  onOpenAddConditionDialog,
  onOpenAddActionDialog,
  onTestSingleAction
}: ActionNodeEditorProps) {
  const { clipboard, copyToClipboard, pastePayload } = useContext(AutomationClipboardContext);
  const [collapsed, setCollapsed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testFiring, setTestFiring] = useState(false);
  const [collapsedBranches, setCollapsedBranches] = useState<Set<number>>(new Set());

  const toggleBranchCollapse = (idx: number) => {
    setCollapsedBranches(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleTestTrigger = async () => {
    if (!onTestSingleAction || testFiring) return;
    setTestFiring(true);
    try {
      await onTestSingleAction(act);
    } finally {
      setTimeout(() => setTestFiring(false), 600);
    }
  };

  // Action naming & catalog resolution (available to all action types and actionButtons)
  const { command: catalogCmd, matchedOption } = catalog ? resolveCatalogCommandForAction(act, catalog) : { command: undefined, matchedOption: undefined };
  const hasOptions = !!(catalogCmd?.options && catalogCmd.options.length > 0);
  const actionName =
    catalogCmd?.ha_metadata?.name ||
    catalogCmd?.name ||
    act.source_command_name ||
    (act.can_id
      ? `CAN Transmit ${formatCanId(act.can_id)}`
      : act.type === 'if_then'
      ? 'IF-THEN-ELSE'
      : act.type === 'choose'
      ? 'CHOOSE'
      : act.type === 'wait_for'
      ? 'Wait For'
      : act.type === 'repeat_until'
      ? 'Repeat Until'
      : act.type === 'cycle_entity'
      ? `Cycle ${act.entity_id || 'Entity'}`
      : act.type === 'climate_target'
      ? 'Climate Target'
      : act.type === 'precondition'
      ? 'Battery Preconditioning'
      : act.type === 'track_popup' || act.type === 'popup'
      ? 'Cluster Popup'
      : act.type === 'delay'
      ? `Delay ${act.delay_ms || act.ms || 0}ms`
      : `Action ${index + 1}`);

  const actionButtons = (
    <div className="flex items-center gap-1 shrink-0 flex-wrap">
      {onTestSingleAction && (
        <button
          type="button"
          onClick={handleTestTrigger}
          disabled={testFiring}
          className={`p-1 sm:p-1.5 rounded-lg border transition flex items-center gap-1 shrink-0 ${
            testFiring
              ? 'bg-emerald-500 text-slate-950 border-emerald-400 animate-pulse'
              : 'bg-emerald-950/40 text-emerald-300 hover:text-emerald-100 hover:bg-emerald-900/60 border-emerald-800/60 hover:border-emerald-500'
          }`}
          title="Manual Trigger: Test this individual action now"
        >
          <Play className={`w-3 h-3 ${testFiring ? 'fill-slate-950' : 'fill-emerald-400'}`} />
          <span className="text-[10px] font-bold hidden sm:inline">Test</span>
        </button>
      )}
      {onMoveUp && (
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0"
          title="Move up"
        >
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
      )}
      {onMoveDown && (
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0"
          title="Move down"
        >
          <ArrowDown className="w-3.5 h-3.5" />
        </button>
      )}
      {onDuplicate && (
        <button
          type="button"
          onClick={onDuplicate}
          className="p-1 text-slate-500 hover:text-cyan-400 transition shrink-0"
          title="Duplicate action"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => copyToClipboard('action', act, actionName)}
        className="p-1 text-slate-500 hover:text-emerald-400 transition shrink-0"
        title="Copy action to clipboard"
      >
        <ClipboardCopy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-slate-500 hover:text-rose-400 transition shrink-0"
        title="Delete action"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  // If IF_THEN:
  if (act.type === 'if_then') {
    return (
      <div className={`p-2.5 sm:p-3 rounded-xl border border-cyan-800/80 bg-cyan-950/20 space-y-3 text-xs min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-cyan-900 text-cyan-200 border border-cyan-700 flex items-center gap-1 min-w-0">
              <GitFork className="w-3 h-3 shrink-0" />
              <span className="truncate">IF - THEN - ELSE</span> {depth > 0 && `(L${depth + 1})`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* IF CONDITIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2 min-w-0 overflow-hidden">
              <ConditionListEditor
                conditions={act.conditions || []}
                depth={depth + 1}
                label="IF (Conditions)"
                emptyText="No conditions in this IF block."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onUpdate={updatedConds => onUpdate({ ...act, conditions: updatedConds })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
              />
            </div>

            {/* THEN ACTIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.then || []}
                depth={depth + 1}
                label="THEN (Execute if True)"
                emptyText="No actions in THEN branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedThen => onUpdate({ ...act, then: updatedThen })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>

            {/* ELSE ACTIONS */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.else || []}
                depth={depth + 1}
                label="ELSE (Execute if False)"
                emptyText="No actions in ELSE branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedElse => onUpdate({ ...act, else: updatedElse })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // If CHOOSE:
  if (act.type === 'choose') {
    return (
      <div className={`p-2 sm:p-3 rounded-xl border border-blue-800/80 bg-blue-950/20 space-y-3 text-xs min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-blue-900 text-blue-200 border border-blue-700 flex items-center gap-1 min-w-0">
              <Split className="w-3 h-3 shrink-0" />
              <span className="truncate">CHOOSE (Sequential Branching)</span> {depth > 0 && `(L${depth + 1})`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* BRANCHES */}
            <div className="space-y-2.5 min-w-0">
              {(act.choices || []).map((ch, chIdx) => {
                const isBranchCollapsed = collapsedBranches.has(chIdx);
                const condCount = ch.conditions?.length || 0;
                const actCount = ch.sequence?.length || 0;
                const branchTitle = ch.label || `Branch #${chIdx + 1}`;

                const moveBranch = (direction: -1 | 1) => {
                  const targetIdx = chIdx + direction;
                  const list = [...(act.choices || [])];
                  if (targetIdx < 0 || targetIdx >= list.length) return;
                  const temp = list[chIdx];
                  list[chIdx] = list[targetIdx];
                  list[targetIdx] = temp;
                  onUpdate({ ...act, choices: list });
                };

                const duplicateBranch = () => {
                  const list = [...(act.choices || [])];
                  const clonedBranch = regenerateBranchIds(ch, true);
                  list.splice(chIdx + 1, 0, clonedBranch);
                  onUpdate({ ...act, choices: list });
                };

                const copyBranch = () => {
                  copyToClipboard('choice_branch', ch, branchTitle);
                };

                return (
                  <div key={ch._clientId || chIdx} className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <button
                          type="button"
                          onClick={() => toggleBranchCollapse(chIdx)}
                          className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
                          title={isBranchCollapsed ? "Expand branch" : "Collapse branch"}
                        >
                          {isBranchCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                        </button>
                        <span className="w-5 h-5 rounded-full bg-blue-950 text-blue-300 font-bold text-[10px] flex items-center justify-center border border-blue-800 shrink-0">
                          #{chIdx + 1}
                        </span>
                        <input
                          type="text"
                          value={ch.label || ''}
                          onChange={e => {
                            const choices = [...(act.choices || [])];
                            choices[chIdx] = { ...ch, label: e.target.value };
                            onUpdate({ ...act, choices });
                          }}
                          placeholder={`Branch #${chIdx + 1} (e.g. Low Heat ➔ Med Heat)`}
                          className="bg-slate-900 border border-slate-800 rounded px-2 py-0.5 text-blue-200 text-xs font-semibold focus:outline-none focus:border-blue-500 flex-1 min-w-0 truncate"
                        />
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={chIdx === 0}
                          onClick={() => moveBranch(-1)}
                          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0 cursor-pointer"
                          title="Move branch up (higher priority)"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={chIdx === (act.choices || []).length - 1}
                          onClick={() => moveBranch(1)}
                          className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition shrink-0 cursor-pointer"
                          title="Move branch down (lower priority)"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={duplicateBranch}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-900 hover:bg-slate-850 text-cyan-300 border border-slate-700 hover:border-cyan-500 transition shrink-0 cursor-pointer"
                          title="Duplicate this branch and all its conditions & sequence actions"
                        >
                          <Copy className="w-3 h-3" />
                          <span className="hidden sm:inline">Duplicate</span>
                        </button>
                        <button
                          type="button"
                          onClick={copyBranch}
                          className="p-1 text-slate-500 hover:text-blue-300 transition shrink-0 cursor-pointer"
                          title="Copy branch to universal clipboard"
                        >
                          <ClipboardCopy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const choices = (act.choices || []).filter((_, i) => i !== chIdx);
                            onUpdate({ ...act, choices });
                          }}
                          className="p-1 text-slate-500 hover:text-rose-400 transition shrink-0 cursor-pointer"
                          title="Delete Branch"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    {isBranchCollapsed ? (
                      <div className="text-[11px] text-slate-400 pl-7 font-mono flex items-center gap-2">
                        <span>
                          {condCount === 0 ? 'No conditions (always matches)' : `${condCount} condition(s)`} ➔ {actCount} action(s)
                        </span>
                      </div>
                    ) : (
                      <>
                        {/* Conditions in Choice */}
                        <div className="pl-1.5 sm:pl-2 border-l border-slate-800 min-w-0">
                          <ConditionListEditor
                            conditions={ch.conditions || []}
                            depth={depth + 1}
                            label="Branch Conditions"
                            emptyText="No conditions in this branch."
                            availableTriggers={availableTriggers}
                            catalog={catalog}
                            liveFrames={liveFrames}
                            entityStates={entityStates}
                            lastFiredTriggerId={lastFiredTriggerId}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onUpdate={updatedConds => {
                              const choices = [...(act.choices || [])];
                              choices[chIdx].conditions = updatedConds;
                              onUpdate({ ...act, choices });
                            }}
                            onOpenAddConditionDialog={onOpenAddConditionDialog}
                          />
                        </div>

                        {/* Sequence in Choice */}
                        <div className="pl-1.5 sm:pl-2 border-l border-slate-800 pt-2 min-w-0">
                          <ActionListEditor
                            actions={ch.sequence || []}
                            depth={depth + 1}
                            label="Branch Sequence Actions"
                            emptyText="No actions in branch sequence."
                            availableTriggers={availableTriggers}
                            catalog={catalog}
                            liveFrames={liveFrames}
                            entityStates={entityStates}
                            lastFiredTriggerId={lastFiredTriggerId}
                            liveWifiStatus={liveWifiStatus}
                            liveBleMap={liveBleMap}
                            onTestSingleAction={onTestSingleAction}
                            onUpdate={updatedSeq => {
                              const choices = [...(act.choices || [])];
                              choices[chIdx].sequence = updatedSeq;
                              onUpdate({ ...act, choices });
                            }}
                            onOpenAddConditionDialog={onOpenAddConditionDialog}
                            onOpenAddActionDialog={onOpenAddActionDialog}
                          />
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2 flex-wrap pt-1">
              <button
                type="button"
                onClick={() => {
                  const choices = [...(act.choices || [])];
                  choices.push({
                    conditions: [],
                    sequence: []
                  });
                  onUpdate({ ...act, choices });
                }}
                className="ha-section-add-btn accent-act"
              >
                <Plus className="w-4 h-4" />
                <span>Add Choice Branch</span>
              </button>

              {clipboard?.type === 'choice_branch' && (
                <button
                  type="button"
                  onClick={() => {
                    const pasted = pastePayload('choice_branch');
                    if (pasted) {
                      onUpdate({ ...act, choices: [...(act.choices || []), pasted] });
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-950/60 hover:bg-blue-900/60 text-blue-200 border border-blue-700/60 transition cursor-pointer"
                  title={`Paste copied choice branch "${clipboard.label}"`}
                >
                  <ClipboardPaste className="w-3.5 h-3.5 text-blue-300" />
                  <span>Paste Branch ({clipboard.label})</span>
                </button>
              )}
            </div>

            {/* DEFAULT SEQUENCE */}
            <div className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2 min-w-0 overflow-hidden">
              <ActionListEditor
                actions={act.default || []}
                depth={depth + 1}
                label="DEFAULT (If no branch matches)"
                emptyText="No actions in DEFAULT branch."
                availableTriggers={availableTriggers}
                catalog={catalog}
                liveFrames={liveFrames}
                entityStates={entityStates}
                lastFiredTriggerId={lastFiredTriggerId}
                liveWifiStatus={liveWifiStatus}
                liveBleMap={liveBleMap}
                onTestSingleAction={onTestSingleAction}
                onUpdate={updatedDef => onUpdate({ ...act, default: updatedDef })}
                onOpenAddConditionDialog={onOpenAddConditionDialog}
                onOpenAddActionDialog={onOpenAddActionDialog}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Unified WAIT (Condition or Delay)
  if (act.type === 'wait_for' || act.type === 'delay') {
    const isDelayMode = act.type === 'delay';
    const condList = act.conditions || (act.condition ? [act.condition] : []);

    const currentTotalMs = act.delay_ms !== undefined && act.delay_ms !== null 
      ? act.delay_ms 
      : (act.ms !== undefined && act.ms !== null ? act.ms : 2000);

    let defaultUnit: 'ms' | 's' | 'mins' | 'hrs' = 'ms';
    let displayVal = currentTotalMs;
    if (currentTotalMs > 0) {
      if (currentTotalMs % 3600000 === 0) {
        defaultUnit = 'hrs';
        displayVal = currentTotalMs / 3600000;
      } else if (currentTotalMs % 60000 === 0) {
        defaultUnit = 'mins';
        displayVal = currentTotalMs / 60000;
      } else if (currentTotalMs % 1000 === 0) {
        defaultUnit = 's';
        displayVal = currentTotalMs / 1000;
      }
    }
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      mins: 60000,
      hrs: 3600000
    };

    return (
      <div className="p-2 sm:p-3 rounded-xl border border-violet-800/80 bg-violet-950/20 space-y-3 text-xs min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
            >
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <span className="px-2 py-0.5 rounded font-bold uppercase tracking-wider text-[10px] bg-violet-900 text-violet-200 border border-violet-700 flex items-center gap-1 min-w-0">
              <Clock className="w-3 h-3 shrink-0" />
              <span className="truncate">WAIT (Condition or Delay)</span>
            </span>
            <span className="px-1.5 py-0.5 rounded bg-violet-950 text-violet-300 text-[10px] font-mono border border-violet-800/60 truncate">
              {isDelayMode 
                ? `Delay: ${displayVal} ${defaultUnit}` 
                : `Wait For Condition (timeout: ${act.timeout_ms || 10000}ms)`}
            </span>
          </div>
          <div className="shrink-0 ml-auto sm:ml-0">
            {actionButtons}
          </div>
        </div>

        {!collapsed && (
          <div className="space-y-3 min-w-0">
            {/* Mode switch */}
            <div className="flex items-center gap-2 p-1 bg-slate-900/80 border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  onUpdate({
                    ...act,
                    type: 'delay',
                    delay_ms: currentTotalMs || 2000,
                    ms: currentTotalMs || 2000
                  });
                }}
                className={`flex-1 py-1 px-2.5 rounded text-xs font-medium transition ${
                  isDelayMode
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                Fixed Delay Duration
              </button>
              <button
                type="button"
                onClick={() => {
                  onUpdate({
                    ...act,
                    type: 'wait_for',
                    timeout_ms: act.timeout_ms || 10000,
                    interval_ms: act.interval_ms || 50,
                    conditions: condList.length > 0 ? condList : [{
                      id: `cond_wait_${Date.now().toString(36)}`,
                      type: 'ble_button',
                      ble_button: 'volume_up',
                      ble_action: 'press'
                    }]
                  });
                }}
                className={`flex-1 py-1 px-2.5 rounded text-xs font-medium transition ${
                  !isDelayMode
                    ? 'bg-violet-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                Wait For Condition / Button Press
              </button>
            </div>

            {isDelayMode ? (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px] items-end">
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Delay Duration Value</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={displayVal || ''}
                      onChange={e => {
                        const raw = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                        const factor = multipliers[defaultUnit] || 1;
                        const total = Math.round(raw * factor);
                        onUpdate({ ...act, type: 'delay', delay_ms: total, ms: total });
                      }}
                      placeholder="0"
                      className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2.5 text-slate-200 font-mono text-xs focus:outline-none focus:border-violet-500 box-border"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Duration Unit</label>
                    <select
                      value={defaultUnit}
                      onChange={e => {
                        const newUnit = e.target.value;
                        const newFactor = multipliers[newUnit] || 1;
                        const total = Math.round(displayVal * newFactor);
                        onUpdate({ ...act, type: 'delay', delay_ms: total, ms: total });
                      }}
                      className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-violet-400 font-sans text-xs focus:outline-none focus:border-violet-500 box-border"
                    >
                      <option value="ms">Milliseconds (ms)</option>
                      <option value="s">Seconds (s)</option>
                      <option value="mins">Minutes (mins)</option>
                      <option value="hrs">Hours (hrs)</option>
                    </select>
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex items-center gap-1.5 flex-wrap pt-1 font-mono text-[10px]">
                  <span className="text-slate-500 font-sans">Quick Presets:</span>
                  {[
                    { label: '250ms', val: 250 },
                    { label: '500ms', val: 500 },
                    { label: '1s', val: 1000 },
                    { label: '2s', val: 2000 },
                    { label: '5s', val: 5000 },
                    { label: '10s', val: 10000 }
                  ].map(p => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => onUpdate({ ...act, type: 'delay', delay_ms: p.val, ms: p.val })}
                      className={`px-2 py-0.5 rounded border transition ${
                        currentTotalMs === p.val
                          ? 'bg-violet-900 text-violet-100 border-violet-500 font-bold'
                          : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                  {currentTotalMs > 0 && (
                    <span className="text-slate-500 ml-auto">
                      = {currentTotalMs.toLocaleString()} ms ({currentTotalMs >= 1000 ? `${(currentTotalMs / 1000).toFixed(1)}s` : `${currentTotalMs}ms`})
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px] items-end">
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Timeout (ms)</label>
                    <input
                      type="number"
                      value={act.timeout_ms || 10000}
                      onChange={e => onUpdate({ ...act, timeout_ms: parseInt(e.target.value) || 10000 })}
                      placeholder="10000 (10 seconds)"
                      className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 font-mono box-border"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <label className="block text-[10px] font-sans text-slate-400 mb-1">Check Interval (ms)</label>
                    <input
                      type="number"
                      value={act.interval_ms || 50}
                      onChange={e => onUpdate({ ...act, interval_ms: parseInt(e.target.value) || 50 })}
                      placeholder="50"
                      className="w-full h-8 bg-slate-900 border border-slate-800 rounded px-2 text-slate-200 font-mono box-border"
                    />
                  </div>
                </div>

                {/* Target Condition in WAIT_FOR */}
                <div className="p-2 sm:p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2 min-w-0 overflow-hidden">
                  <ConditionListEditor
                    conditions={condList}
                    depth={depth + 1}
                    label="Target Condition (e.g. Volume Up / Down or Key Pressed)"
                    emptyText="No target condition set (will proceed immediately)."
                    availableTriggers={availableTriggers}
                    catalog={catalog}
                    liveFrames={liveFrames}
                    entityStates={entityStates}
                    lastFiredTriggerId={lastFiredTriggerId}
                    liveWifiStatus={liveWifiStatus}
                    liveBleMap={liveBleMap}
                    onUpdate={updatedConds => {
                      onUpdate({
                        ...act,
                        conditions: updatedConds,
                        condition: updatedConds[0]
                      });
                    }}
                    onOpenAddConditionDialog={onOpenAddConditionDialog}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Regular action step rendering uses catalogCmd, matchedOption, hasOptions, and actionName declared above
  const effectiveCanId =
    act.can_id ||
    catalogCmd?.network?.action_can_id ||
    catalogCmd?.action_can_id ||
    catalogCmd?.network?.state_can_id ||
    catalogCmd?.state_can_id ||
    '';
  const effectiveBus = act.bus ?? catalogCmd?.network?.bus ?? catalogCmd?.action_bus ?? catalogCmd?.bus ?? 0;
  const effectiveRepeat =
    act.repeat !== undefined
      ? act.repeat
      : matchedOption?.repeat ?? (matchedOption?.steps && matchedOption.steps[0]?.repeat) ?? catalogCmd?.repeat ?? 1;
  const effectiveDelayMs =
    act.delay_ms !== undefined
      ? act.delay_ms
      : matchedOption?.delay_ms ??
        (matchedOption?.steps && matchedOption.steps[0]?.delay_ms) ??
        catalogCmd?.network?.delay_ms ??
        catalogCmd?.delay_ms ??
        0;

  const rawEffectivePayload =
    (typeof act.payload === 'object' && act.payload && Object.keys(act.payload).length > 0
      ? act.payload
      : typeof act.payload === 'string' && act.payload.trim() !== ''
      ? act.payload
      : undefined) ??
    matchedOption?.payload ??
    (matchedOption?.steps && matchedOption.steps[0]?.payload) ??
    catalogCmd?.payload;

  const effectivePayloadMap = compileToByteMap(rawEffectivePayload);
  const effectivePayload =
    Object.keys(effectivePayloadMap).length > 0
      ? effectivePayloadMap
      : typeof rawEffectivePayload === 'string'
      ? rawEffectivePayload
      : '';

  const effectiveSteps: AutomationActionStep[] | undefined = (() => {
    const rawList =
      act.steps && act.steps.length > 0
        ? act.steps
        : matchedOption?.steps && matchedOption.steps.length > 0
        ? matchedOption.steps
        : !matchedOption?.payload && catalogCmd?.steps && catalogCmd.steps.length > 0
        ? catalogCmd.steps
        : undefined;
    if (!rawList || rawList.length === 0) return undefined;
    return rawList.map((s, idx) => {
      const sMap = compileToByteMap(s.payload);
      const fallbackStepPayload =
        matchedOption?.steps?.[idx]?.payload ?? catalogCmd?.steps?.[idx]?.payload;
      const finalMap = Object.keys(sMap).length > 0 ? sMap : compileToByteMap(fallbackStepPayload);
      return {
        can_id: s.can_id || effectiveCanId || '0x000',
        bus: s.bus ?? effectiveBus,
        repeat: s.repeat ?? 1,
        delay_ms: s.delay_ms ?? 0,
        payload:
          Object.keys(finalMap).length > 0
            ? finalMap
            : typeof s.payload === 'string' && s.payload.trim() !== ''
            ? s.payload
            : ''
      };
    });
  })();

  const activeOptionLabel = (act.option_label || act.command || matchedOption?.label || '').toLowerCase().trim();

  const renderByteBoxes = (byteSource: any) => {
    const map = typeof byteSource === 'object' && byteSource !== null ? byteSource : compileToByteMap(byteSource);
    const keys = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
    return (
      <div className="grid grid-cols-8 gap-1 pt-1">
        {keys.map(k => {
          const val = map[k];
          const hasVal = val !== undefined && val !== '' && val !== '*';
          const isNonZero = hasVal && val !== '0x00' && val !== '00' && val !== '0';
          return (
            <div
              key={k}
              className={`flex flex-col items-center justify-center py-1 px-0.5 rounded border text-[10px] font-mono transition-colors ${
                isNonZero
                  ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200 font-bold shadow-sm'
                  : hasVal
                  ? 'bg-slate-900 border-slate-700/80 text-slate-300'
                  : 'bg-slate-950/60 border-slate-800/60 text-slate-600'
              }`}
              title={`Byte ${k}: ${val || '*'}`}
            >
              <span className="text-[8px] text-slate-500 leading-none mb-0.5">{k}</span>
              <span className="leading-none">{val || '*'}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="p-2.5 sm:p-3.5 rounded-xl bg-slate-950 border border-slate-800/90 hover:border-slate-700/80 space-y-2.5 text-xs transition-all shadow-sm min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="text-slate-400 hover:text-white transition p-0.5 shrink-0"
          >
            {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-300 font-bold text-[10px] flex items-center justify-center border border-emerald-800 shrink-0">
            A{index + 1}
          </span>
          <span className="font-semibold text-white text-xs sm:text-sm tracking-tight truncate">{actionName}</span>
          {effectiveSteps && effectiveSteps.length > 1 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-900/40 text-emerald-300 border border-emerald-700/60 shrink-0">
              {effectiveSteps.length} Steps
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-auto sm:ml-0">
          {hasOptions && !collapsed && (
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`inline-flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium border transition cursor-pointer ${
                showAdvanced
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/80 shadow'
                  : 'bg-slate-900 text-slate-300 hover:text-white border-slate-800 hover:bg-slate-850'
              }`}
              title="Toggle configuration details"
            >
              <Sliders className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden xs:inline sm:inline">{showAdvanced ? 'Simple' : 'Details'}</span>
            </button>
          )}
          {actionButtons}
        </div>
      </div>

      {!collapsed && (
        <>

      {/* Option Selector Big Pills in Smart Grid Rows */}
      {hasOptions && (
        <div className="space-y-1.5 pt-0.5">
          {groupOptionsIntoGridRows(catalogCmd.options).map((group, gIdx) => {
            const itemCount = group.items.length;
            const gridClass =
              itemCount === 1
                ? 'flex'
                : itemCount === 2
                ? 'grid grid-cols-2 gap-1.5'
                : itemCount === 3
                ? 'grid grid-cols-2 sm:grid-cols-3 gap-1.5'
                : itemCount === 4
                ? 'grid grid-cols-2 sm:grid-cols-4 gap-1.5'
                : 'grid grid-cols-2 sm:grid-cols-3 gap-1.5';

            return (
              <div key={group.key || gIdx} className={gridClass}>
                {group.items.map(({ opt, origIndex }) => {
                  const isSelected = activeOptionLabel
                    ? opt.label.toLowerCase().trim() === activeOptionLabel
                    : origIndex === 0;

                  return (
                    <button
                      key={opt.label || origIndex}
                      type="button"
                      onClick={() => {
                        const updated = applyOptionToAction(act, catalogCmd, opt);
                        onUpdate(updated);
                      }}
                      className={`${
                        itemCount === 1 ? 'px-4 min-w-[90px]' : 'w-full px-2'
                      } py-1.5 rounded-lg text-xs font-medium transition flex items-center justify-center gap-1.5 border cursor-pointer text-center ${
                        isSelected
                          ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/80 font-semibold shadow-sm ring-1 ring-emerald-500/40'
                          : 'bg-slate-900/90 text-slate-400 hover:text-slate-200 hover:bg-slate-800 border-slate-800'
                      }`}
                    >
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      {/* Advanced Details View */}
      {(!hasOptions || showAdvanced) && (() => {
        const isCanTx =
          act.type === 'can_tx' ||
          act.type === 'entity_command' ||
          act.type === 'transmit' ||
          !['precondition', 'climate_target', 'track_popup', 'popup', 'delay', 'if_then', 'choose', 'webhook'].includes(act.type);
        const hasMultipleSteps = isCanTx && !!(effectiveSteps && effectiveSteps.length > 1);

        return (
        <div className={`space-y-3 ${hasOptions ? 'pt-2.5 border-t border-slate-850' : ''}`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 font-mono text-[11px]">
            <div>
              <label className="block text-[10px] font-sans text-slate-500">Action Type</label>
              <select
                value={isCanTx ? 'can_tx' : act.type}
                onChange={e => onUpdate({ ...act, type: e.target.value as any })}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
              >
                <option value="can_tx">can_tx (CAN Transmit)</option>
                <option value="precondition">precondition (E-GMP)</option>
                <option value="climate_target">climate_target (HVAC Temp Target)</option>
                <option value="track_popup">track_popup (Cluster Popup)</option>
                <option value="delay">delay</option>
                <option value="if_then">if_then (Conditional Branch)</option>
                <option value="choose">choose (Multiple Choices)</option>
                <option value="webhook">webhook (HTTP)</option>
              </select>
            </div>

            {act.type === 'precondition' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Operation</label>
                  <select
                    value={act.precon_action || 'start'}
                    onChange={e => onUpdate({ ...act, precon_action: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="start">Start Preconditioning</option>
                    <option value="stop">Stop / Cancel</option>
                    <option value="toggle">Toggle State</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Operating Mode</label>
                  <select
                    value={act.precon_mode || 'persistent'}
                    onChange={e => onUpdate({ ...act, precon_mode: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-orange-300 font-medium font-sans"
                  >
                    <option value="persistent">Persistent (21°C / 70°F)</option>
                    <option value="continuous">Continuous (High Demand)</option>
                    <option value="once">Single Cycle (Once)</option>
                  </select>
                </div>
              </>
            )}

            {act.type === 'climate_target' && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Zone</label>
                  <select
                    value={act.zone || 'driver'}
                    onChange={e => onUpdate({ ...act, zone: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="driver">Driver Zone</option>
                    <option value="passenger">Passenger Zone</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-sans text-slate-500">Target Temp</label>
                    <span className="text-[9px] text-teal-400 font-mono">
                      {act.target_temp_c !== undefined || act.target_c !== undefined
                        ? `${Math.round(((act.target_temp_c ?? act.target_c ?? 21.0) * 9 / 5 + 32) * 10) / 10}°F`
                        : '--°F'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.5"
                      min="14"
                      max="32"
                      value={act.target_temp_c ?? act.target_c ?? ''}
                      onChange={e => {
                        const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        onUpdate({ ...act, target_temp_c: val, target_c: val });
                      }}
                      placeholder="21.0"
                      className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-teal-300 font-bold"
                    />
                    <span className="text-slate-400 font-sans text-xs">°C</span>
                  </div>
                </div>
              </>
            )}

            {(act.type === 'track_popup' || act.type === 'popup') && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Severity Level</label>
                  <select
                    value={act.level || 'info'}
                    onChange={e => onUpdate({ ...act, level: e.target.value as any })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-sans text-slate-500">Popup Text</label>
                    <span className="text-[9px] text-slate-500 font-mono">
                      {(act.text || act.popup_message || '').length}/50
                    </span>
                  </div>
                  <input
                    type="text"
                    maxLength={50}
                    value={act.text || act.popup_message || ''}
                    onChange={e => onUpdate({ ...act, text: e.target.value, popup_message: e.target.value })}
                    placeholder="Message text..."
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-amber-300 font-medium"
                  />
                </div>
              </>
            )}

            {act.type === 'cycle_entity' && (
              <div className="col-span-full space-y-2.5 p-3 rounded-lg bg-slate-900/90 border border-amber-900/60 font-sans">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-amber-400 flex items-center gap-1.5">
                    <RotateCw className="w-3.5 h-3.5 text-amber-400" />
                    <span>Cyclic Stepper Configuration</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {act.direction === 'reverse' ? 'Reverse ◀' : 'Forward ▶'} · {act.wrap !== false ? 'Wrap: ON' : 'Wrap: OFF'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Target Entity ID</label>
                    <input
                      type="text"
                      value={act.entity_id || 'drivers_seat_comfort'}
                      onChange={e => onUpdate({ ...act, entity_id: e.target.value })}
                      placeholder="drivers_seat_comfort"
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-amber-300 font-mono font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Step Direction</label>
                    <select
                      value={act.direction || 'forward'}
                      onChange={e => onUpdate({ ...act, direction: e.target.value as any })}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    >
                      <option value="forward">Forward (Increment)</option>
                      <option value="reverse">Reverse (Decrement)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Wrap on Overflow</label>
                    <select
                      value={act.wrap !== false ? 'true' : 'false'}
                      onChange={e => onUpdate({ ...act, wrap: e.target.value === 'true' })}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    >
                      <option value="true">Yes (High ➔ Off)</option>
                      <option value="false">No (Clamp at High)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Fallback State (Unknown State)</label>
                    <input
                      type="text"
                      value={act.fallback_state || (act.states && act.states[0]) || 'Off'}
                      onChange={e => onUpdate({ ...act, fallback_state: e.target.value })}
                      placeholder="Off"
                      className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                    />
                  </div>
                </div>

                {/* State Options Sequence */}
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">
                    Cycle Sequence States (Comma-separated):
                  </label>
                  <input
                    type="text"
                    value={(act.states || ['Off', 'Low Heat', 'Medium Heat', 'High Heat']).join(', ')}
                    onChange={e => {
                      const parsed = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                      onUpdate({ ...act, states: parsed });
                    }}
                    placeholder="Off, Low Heat, Medium Heat, High Heat"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-amber-200 font-mono text-xs"
                  />
                </div>

                {/* In-Cabin Confirmation Popup */}
                <div className="pt-2 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] items-center">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={act.show_popup ?? true}
                      onChange={e => onUpdate({ ...act, show_popup: e.target.checked })}
                      className="rounded bg-slate-900 border-slate-700 text-amber-500 focus:ring-0"
                    />
                    <span className="text-slate-300">Auto-show Cluster / HUD Popup Toast</span>
                  </label>
                  {act.show_popup !== false && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-slate-500 shrink-0">Popup Prefix:</span>
                      <input
                        type="text"
                        value={act.popup_prefix !== undefined ? act.popup_prefix : 'Driver Seat: '}
                        onChange={e => onUpdate({ ...act, popup_prefix: e.target.value })}
                        placeholder="Driver Seat: "
                        className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-amber-300 font-medium text-[11px]"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {isCanTx && !hasMultipleSteps && (
              <>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Target CAN ID</label>
                  <input
                    type="text"
                    value={effectiveCanId}
                    onChange={e => onUpdate({ ...act, can_id: e.target.value, type: 'can_tx' })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                    placeholder="0x524"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Bus</label>
                  <select
                    value={effectiveBus}
                    onChange={e => onUpdate({ ...act, bus: parseInt(e.target.value) || 0, type: 'can_tx' })}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                  >
                    <option value={0}>Bus 0</option>
                    <option value={1}>Bus 1</option>
                    <option value={2}>Bus 2</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-sans text-slate-500">Repeat × Delay</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={effectiveRepeat}
                      onChange={e => onUpdate({ ...act, repeat: parseInt(e.target.value) || 1, type: 'can_tx' })}
                      className="w-12 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                    />
                    <span className="text-slate-500 font-sans">×</span>
                    <input
                      type="number"
                      value={effectiveDelayMs}
                      onChange={e => onUpdate({ ...act, delay_ms: parseInt(e.target.value) || 0, type: 'can_tx' })}
                      placeholder="ms"
                      className="w-16 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {act.type === 'climate_target' && (
            <div className="flex items-center gap-4 pt-1 font-sans text-[11px] text-slate-400">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={act.sync_on ?? true}
                  onChange={e => onUpdate({ ...act, sync_on: e.target.checked })}
                  className="rounded bg-slate-900 border-slate-700 text-teal-500 focus:ring-0"
                />
                <span>Sync Passenger Zone (0x4A0)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={act.driver_only ?? false}
                  onChange={e => onUpdate({ ...act, driver_only: e.target.checked })}
                  className="rounded bg-slate-900 border-slate-700 text-teal-500 focus:ring-0"
                />
                <span>Driver Only</span>
              </label>
            </div>
          )}

          {isCanTx && !hasMultipleSteps && (
            <div className="space-y-2 font-mono text-[11px]">
              <div>
                <label className="block text-[10px] font-sans text-slate-500">Payload (1-based D1..D8)</label>
                <input
                  type="text"
                  value={
                    typeof effectivePayload === 'object' && effectivePayload && Object.keys(effectivePayload).length > 0
                      ? JSON.stringify(effectivePayload)
                      : typeof effectivePayload === 'string'
                      ? effectivePayload
                      : ''
                  }
                  onChange={e => {
                    const compiled = compileToByteMap(e.target.value);
                    onUpdate({ ...act, payload: Object.keys(compiled).length > 0 ? compiled : e.target.value, type: 'can_tx' });
                  }}
                  placeholder='{"D1":"0x02","D2":"0x01"}'
                  className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-emerald-300 font-bold"
                />
                {renderByteBoxes(effectivePayload)}
              </div>
              <div className="flex items-center justify-between pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    const currentStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: effectiveRepeat,
                      delay_ms: effectiveDelayMs || 20,
                      payload: effectivePayload || ''
                    };
                    const secondStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: 1,
                      delay_ms: 20,
                      payload: ''
                    };
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: [currentStep, secondStep]
                    });
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-slate-900 hover:bg-slate-850 text-slate-300 hover:text-white border border-slate-800 transition cursor-pointer"
                >
                  <Plus className="w-3 h-3 text-emerald-400" />
                  <span>Add Step (Convert to Sequence)</span>
                </button>
              </div>
            </div>
          )}

          {/* Dedicated Multi-Step Sequence Editor */}
          {hasMultipleSteps && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-emerald-400" />
                    Sequence Steps ({effectiveSteps!.length})
                  </span>
                  <span className="text-[10px] text-slate-500 font-sans">Frames will transmit sequentially in order</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const newStep: AutomationActionStep = {
                      can_id: effectiveCanId || '0x000',
                      bus: effectiveBus,
                      repeat: 1,
                      delay_ms: 20,
                      payload: ''
                    };
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: [...effectiveSteps!, newStep]
                    });
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800/80 hover:bg-emerald-900 hover:text-white transition cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Add Step</span>
                </button>
              </div>

              <div className="space-y-2.5">
                {effectiveSteps!.map((step, sIdx) => {
                  const payloadStr = typeof step.payload === 'object' && step.payload && Object.keys(step.payload).length > 0
                    ? JSON.stringify(step.payload)
                    : (typeof step.payload === 'string' ? step.payload : '');

                  const updateStep = (patch: Partial<AutomationActionStep>) => {
                    const updatedSteps = effectiveSteps!.map((st, i) => (i === sIdx ? { ...st, ...patch } : st));
                    const isFirstStep = sIdx === 0;
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: updatedSteps,
                      ...(isFirstStep ? {
                        can_id: patch.can_id !== undefined ? patch.can_id : effectiveCanId,
                        bus: patch.bus !== undefined ? patch.bus : effectiveBus,
                        repeat: patch.repeat !== undefined ? patch.repeat : effectiveRepeat,
                        delay_ms: patch.delay_ms !== undefined ? patch.delay_ms : effectiveDelayMs,
                        payload: patch.payload !== undefined ? patch.payload : effectivePayload
                      } : {})
                    });
                  };

                  const removeStep = () => {
                    const updatedSteps = effectiveSteps!.filter((_, i) => i !== sIdx);
                    if (updatedSteps.length <= 1) {
                      const remaining = updatedSteps[0] || { can_id: effectiveCanId, bus: effectiveBus, payload: effectivePayload, repeat: effectiveRepeat, delay_ms: effectiveDelayMs };
                      onUpdate({
                        ...act,
                        type: 'can_tx',
                        steps: undefined,
                        can_id: remaining.can_id || effectiveCanId,
                        bus: remaining.bus ?? effectiveBus ?? 0,
                        repeat: remaining.repeat ?? effectiveRepeat ?? 1,
                        delay_ms: remaining.delay_ms ?? effectiveDelayMs ?? 0,
                        payload: remaining.payload || effectivePayload
                      });
                    } else {
                      onUpdate({
                        ...act,
                        type: 'can_tx',
                        steps: updatedSteps,
                        ...(sIdx === 0 ? {
                          can_id: updatedSteps[0].can_id,
                          bus: updatedSteps[0].bus,
                          repeat: updatedSteps[0].repeat,
                          delay_ms: updatedSteps[0].delay_ms,
                          payload: updatedSteps[0].payload
                        } : {})
                      });
                    }
                  };

                  const moveStep = (direction: -1 | 1) => {
                    const targetIdx = sIdx + direction;
                    if (targetIdx < 0 || targetIdx >= effectiveSteps!.length) return;
                    const reordered = [...effectiveSteps!];
                    const temp = reordered[sIdx];
                    reordered[sIdx] = reordered[targetIdx];
                    reordered[targetIdx] = temp;
                    onUpdate({
                      ...act,
                      type: 'can_tx',
                      steps: reordered,
                      can_id: reordered[0].can_id,
                      bus: reordered[0].bus,
                      repeat: reordered[0].repeat,
                      delay_ms: reordered[0].delay_ms,
                      payload: reordered[0].payload
                    });
                  };

                  return (
                    <div key={sIdx} className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-300 font-bold text-[10px] flex items-center justify-center border border-emerald-800">
                            {sIdx + 1}
                          </span>
                          <span className="font-semibold text-slate-200 text-[11px] font-sans">Step {sIdx + 1} of {effectiveSteps!.length}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={sIdx === 0}
                            onClick={() => moveStep(-1)}
                            className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition cursor-pointer"
                            title="Move step up"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            disabled={sIdx === effectiveSteps!.length - 1}
                            onClick={() => moveStep(1)}
                            className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500 transition cursor-pointer"
                            title="Move step down"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={removeStep}
                            className="p-1 text-slate-500 hover:text-rose-400 transition cursor-pointer ml-1"
                            title="Remove this step"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">Target CAN ID</label>
                          <input
                            type="text"
                            value={step.can_id || ''}
                            onChange={e => updateStep({ can_id: e.target.value })}
                            className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
                            placeholder={effectiveCanId || "0x524"}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">Bus</label>
                          <select
                            value={step.bus ?? 0}
                            onChange={e => updateStep({ bus: parseInt(e.target.value) || 0 })}
                            className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-sans"
                          >
                            <option value={0}>Bus 0</option>
                            <option value={1}>Bus 1</option>
                            <option value={2}>Bus 2</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-sans text-slate-500">Repeat × Delay</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              value={step.repeat !== undefined ? step.repeat : 1}
                              onChange={e => updateStep({ repeat: parseInt(e.target.value) || 1 })}
                              className="w-12 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                            />
                            <span className="text-slate-500 font-sans">×</span>
                            <input
                              type="number"
                              value={step.delay_ms !== undefined ? step.delay_ms : 0}
                              onChange={e => updateStep({ delay_ms: parseInt(e.target.value) || 0 })}
                              placeholder="ms"
                              className="w-16 bg-slate-950 border border-slate-800 rounded px-1.5 py-1 text-slate-200"
                            />
                          </div>
                        </div>
                      </div>

                      <div className="space-y-1 font-mono text-[11px]">
                        <label className="block text-[10px] font-sans text-slate-500">Step {sIdx + 1} Payload (1-based D1..D8)</label>
                        <input
                          type="text"
                          value={payloadStr}
                          onChange={e => {
                            const compiled = compileToByteMap(e.target.value);
                            updateStep({ payload: Object.keys(compiled).length > 0 ? compiled : e.target.value });
                          }}
                          placeholder='{"D1":"0x02","D2":"0x01"}'
                          className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-emerald-300 font-bold"
                        />
                        {renderByteBoxes(step.payload)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        );
      })()}
        </>
      )}
    </div>
  );
}

export function ActionListEditor({
  actions,
  depth = 0,
  label,
  emptyText = 'No actions defined.',
  availableTriggers,
  catalog,
  liveFrames,
  entityStates,
  lastFiredTriggerId,
  liveWifiStatus,
  liveBleMap,
  onUpdate,
  onOpenAddConditionDialog,
  onOpenAddActionDialog,
  onTestSingleAction
}: ActionListEditorProps) {
  const { clipboard, pastePayload } = useContext(AutomationClipboardContext);

  const addDefaultAction = () => {
    const next = [...actions];
    next.push({
      id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'can_tx',
      can_id: '',
      bus: 0,
      payload: '',
      repeat: 1,
      delay_ms: 0
    });
    onUpdate(next);
  };

  return (
    <div className="space-y-2 min-w-0">
      {label && (
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-emerald-400 font-bold text-[11px] uppercase tracking-wider truncate">
            {label} ({actions.length})
          </span>
        </div>
      )}

      {actions.length === 0 ? (
        <div className="p-3 rounded-xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500 italic">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2 min-w-0">
                  {actions.map((act, idx) => {
                    const stableKey = act._clientId || (act._clientId = `act_client_${idx}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
                    return (
                      <ActionNodeEditor
                        key={stableKey}
                        act={act}
                        index={idx}
                        depth={depth}
                        availableTriggers={availableTriggers}
                        catalog={catalog}
                        liveFrames={liveFrames}
                        entityStates={entityStates}
                        lastFiredTriggerId={lastFiredTriggerId}
                        liveWifiStatus={liveWifiStatus}
                        liveBleMap={liveBleMap}
                        onTestSingleAction={onTestSingleAction}
                        onUpdate={updated => {
                          const next = [...actions];
                          next[idx] = { ...updated, _clientId: stableKey };
                          onUpdate(next);
                        }}
                        onDelete={() => {
                          const next = actions.filter((_, i) => i !== idx);
                          onUpdate(next);
                        }}
                        onDuplicate={() => {
                          const dup = regenerateActionIds(act);
                          const next = [...actions];
                          next.splice(idx + 1, 0, dup);
                          onUpdate(next);
                        }}
                        onMoveUp={idx > 0 ? () => {
                          const next = [...actions];
                          const temp = next[idx];
                          next[idx] = next[idx - 1];
                          next[idx - 1] = temp;
                          onUpdate(next);
                        } : undefined}
                        onMoveDown={idx < actions.length - 1 ? () => {
                          const next = [...actions];
                          const temp = next[idx];
                          next[idx] = next[idx + 1];
                          next[idx + 1] = temp;
                          onUpdate(next);
                        } : undefined}
                        isFirst={idx === 0}
                        isLast={idx === actions.length - 1}
                        onOpenAddConditionDialog={onOpenAddConditionDialog}
                        onOpenAddActionDialog={onOpenAddActionDialog}
                      />
                    );
                  })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (onOpenAddActionDialog) {
              onOpenAddActionDialog(newAct => onUpdate([...actions, newAct]));
            } else {
              addDefaultAction();
            }
          }}
          className="ha-section-add-btn accent-act"
        >
          <Plus className="w-4 h-4" />
          <span>Add Action</span>
        </button>

        {clipboard?.type === 'action' && (
          <button
            type="button"
            onClick={() => {
              const pasted = pastePayload('action');
              if (pasted) onUpdate([...actions, pasted]);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 border border-emerald-700/60 transition cursor-pointer"
            title={`Paste copied action: "${clipboard.label}"`}
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-emerald-300" />
            <span>Paste Action ({clipboard.label})</span>
          </button>
        )}
      </div>
    </div>
  );
}
