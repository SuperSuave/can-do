# Automation Builder Workflow Overhaul & Multi-Level Stepper Engine

A comprehensive implementation plan integrating the **Cyclic Stepper Action (`cycle_entity`)**, **Choose Card Branch Duplication & Reordering**, and **Universal Cross-Type Block Clipboard** across `frontend/src/types/automation.ts`, `frontend/src/utils/automationConverters.ts`, `frontend/src/components/AutomationBuilder.tsx`, and `frontend/src/utils/automationConverters.test.ts`.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **Synthesized Architectural Decisions from Reference Document**:
> - **Cycle Entity Schema (`cycle_entity`)**:
>   - Custom subset selection via `states: string[]` (e.g. allowing `["Off", "Low", "Med", "High"]` without being forced to include Cooling states).
>   - Direction control (`forward` | `reverse`) and `wrap: boolean` (allowing Paddle + and Paddle - to step without branching).
>   - Deterministic `fallback_state` for boot/wake scenarios before bus frames are received.
>   - Integrated HUD/cluster popup (`show_popup: true`, `popup_prefix: "Driver Seat: "`) eliminating secondary popup action steps.
> - **Choose Card Branch Productivity**:
>   - One-click branch duplication (`Duplicate Branch`) with recursive ID regeneration (`_clientId`, `cond_...`, `act_...`).
>   - Branch reordering (`[▲] Move Up` / `[▼] Move Down`) to modify evaluation priority.
>   - Inline editable branch label (`label?: string`) with collapsible branch accordions and auto-generated summaries (e.g., `Branch #2: Driver Seat == Low Heat ➔ 2 Actions`).
> - **Universal Cross-Type Clipboard**:
>   - In-memory React state backed by `sessionStorage` with fallback JSON export to `navigator.clipboard.writeText()` for cross-tab/cross-device sharing.
>   - **Smart Cross-Type Pasting**: Allows a copied Trigger to be pasted as a Condition (mapping `to` ➔ `state`) and vice versa.
>   - Full block support for Actions, Conditions, Choice Branches, Triggers, and Whole-Rule cloning.

---

## 1. Overview & Core Concept

Automating multi-level vehicle controls (such as 3-level heated/ventilated seats, sunroof tilt/slide, HVAC blower speeds, regen levels, and ambient lighting) currently suffers from severe authoring friction:
1. **Repetitive Branching**: In Choose cards, each branch must be configured from scratch, even when only one value changes.
2. **Boilerplate Explosion**: Implementing a basic 3-stage stepper requires 4 branches and multiple condition checks.
3. **Immobile Blocks**: Users cannot copy actions or conditions between rules or reorder branches once created.

This implementation delivers a two-pronged solution:
- **High-Level Stepper (`cycle_entity`)**: 1 trigger + 1 action replaces complex multi-branch state machines for standard cyclic loops.
- **Builder Productivity Suite**: Branch duplication, branch reordering, branch labeling, cross-type clipboard pasting, and whole-rule cloning make custom multi-condition state machines effortless.

---

## 2. User Experience & Visual Design

### 1. Choose Card: Branch Duplication, Reordering & Labeling

```
┌────────────────────────────────────────────────────────────────────────┐
│ [▼] CHOOSE (Sequential Branching)                      [Copy] [✕]      │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─ [▼] Branch #1: [ Low Heat Step                ] ─ [▲][▼][Copy][✕] ┐│
│  │                                                                    ││
│  │  ├─ Branch Conditions (1)                                          ││
│  │  │  [C1] Driver Seat Comfort == "Off"                              ││
│  │  │  [+ Add Condition]   [📋 Paste as Condition]                    ││
│  │  │                                                                 ││
│  │  └─ Branch Sequence Actions (2)                                    ││
│  │     [A1] Set Driver Seat Comfort ➔ "Low Heat"                      ││
│  │     [A2] Cluster Popup: "Driver Seat: Low Heat"                    ││
│  │     [+ Add Action]   [📋 Paste Action]                             ││
│  └────────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  ┌─ [▶] Branch #2: Driver Seat == Low Heat ➔ 2 Actions ─ [▲][▼][Copy] ┐│
│  └────────────────────────────────────────────────────────────────────┘│
│                                                                        │
│  [📋 Paste Branch from Clipboard]     [+ Add Empty Choice Branch]       │
│                                                                        │
│  ┌─ DEFAULT (If no branch matches) ───────────────────────────────────┐│
│  │  [No actions in DEFAULT branch]                                    ││
│  └────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────┘
```

- **Collapsible Branches**: Users can collapse branches; when collapsed, an auto-summary shows `Branch #X: <Condition Summary> ➔ N Actions`.
- **Duplicate Branch Button**: Clones all branch conditions and sequence actions with deep-regenerated IDs in a single click.
- **Branch Reordering**: `[▲]` and `[▼]` buttons adjust rule evaluation order.

---

### 2. Universal Clipboard Toolbar & Cross-Type Pasting

```
┌────────────────────────────────────────────────────────────────────────┐
│ 📋 Clipboard: Copied Trigger "When Driver Seat changes to Off"         │
│               [Clear]                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

- When copying a **Trigger**, condition sections display **`[📋 Paste as Condition]`**, automatically converting the trigger into an equivalent state condition (`convertTriggerToCondition`).
- When copying an **Action**, action sequences display **`[📋 Paste Action]`**, appending the cloned action.
- When copying a **Choice Branch**, the Choose card displays **`[📋 Paste Branch]`**.
- System clipboard synchronization (`navigator.clipboard.writeText`) allows pasting serialized JSON between browser tabs or sharing via chat.

---

### 3. Native Cyclic Stepper (`cycle_entity`) Card

```
┌────────────────────────────────────────────────────────────────────────┐
│ ACTION #1: Cycle Entity State                                          │
├────────────────────────────────────────────────────────────────────────┤
│ Target Entity:      [ Driver Seat Comfort (0x4A2)                    ▼]│
│                                                                        │
│ State Cycle Sequence:                                                  │
│   [x] Off   [x] Low Heat   [x] Med Heat   [x] High Heat   [ ] Cool...  │
│                                                                        │
│ Direction:          (•) Forward (Increment)   ( ) Reverse (Decrement)  │
│ Wrap on Overflow:   [x] Yes (High Heat ➔ Off)                          │
│ Fallback State:     [ Off                                            ▼]│
│                                                                        │
│ Cluster / HUD Toast:                                                   │
│   [x] Auto-trigger Cluster / HUD Popup                                 │
│   Prefix:           [ Driver Seat:                                    ]│
│   Preview Output:   "Driver Seat: Med Heat"                            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Technical Architecture & Implementation Steps

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 1: Type Definitions (frontend/src/types/automation.ts)                    │
│ • ChoiceBranch: Add label?: string and _clientId?: string                      │
│ • CycleEntityAction: Full schema (states, direction, wrap, fallback, popup)    │
│ • ClipboardBlockType & AutomationClipboardItem interfaces                      │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 2: Deep-Cloning & Converters (frontend/src/utils/automationConverters.ts) │
│ • generateBlockId(prefix): Unique timestamp + random ID generator              │
│ • deepClone<T>(obj): structuredClone with JSON fallback                        │
│ • regenerateTriggerIds, regenerateConditionIds, regenerateBranchIds            │
│ • regenerateActionIds: Deep recursive ID regeneration for choose/if/repeat     │
│ • cloneRuleWithNewIds: Whole-automation cloning                                │
│ • convertTriggerToCondition & convertConditionToTrigger: Cross-type pasting    │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 3: Unit Testing (frontend/src/utils/automationConverters.test.ts)         │
│ • Verify deep cloning does not mutate source branches                          │
│ • Verify nested ID regeneration inside choose branches and condition trees     │
│ • Verify Trigger <-> Condition cross-type conversion                           │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 4: UI Integration (frontend/src/components/AutomationBuilder.tsx)         │
│ • sessionStorage-backed clipboard state & helpers (copy, paste, clear)         │
│ • Choose Card: Duplicate Branch, Move Up/Down, Label Input, Collapsible View   │
│ • Action / Condition / Trigger cards: Copy button & Paste insertion points     │
│ • Whole-Rule Clone button in automation header                                 │
│ • CycleEntityAction configuration UI in ActionNodeEditor                       │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│ Step 5: Verification & Build                                                   │
│ • Run test suite (npm run test / vitest)                                       │
│ • Compile applet via compile_applet                                            │
│ • Test interactive duplication, reordering, and cross-type paste in browser    │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Code Reference

### 1. Type Extensions (`frontend/src/types/automation.ts`)
```typescript
export interface ChoiceBranch {
  _clientId?: string;
  label?: string; // Friendly custom branch name (e.g., "Low Heat ➔ Med Heat")
  conditions: AutomationCondition[];
  sequence: AutomationAction[];
}

export interface CycleEntityAction {
  id?: string;
  _clientId?: string;
  type: 'cycle_entity';
  entity_id: string;
  states: string[];
  direction?: 'forward' | 'reverse';
  wrap?: boolean;
  fallback_state?: string;
  show_popup?: boolean;
  popup_prefix?: string;
}

export type ClipboardBlockType = 'action' | 'condition' | 'choice_branch' | 'trigger';

export interface AutomationClipboardItem {
  type: ClipboardBlockType;
  data: AutomationAction | AutomationCondition | ChoiceBranch | AutomationTrigger;
  label: string;
  copiedAt: number;
}
```

### 2. Converter & Cloning Utilities (`frontend/src/utils/automationConverters.ts`)
- `generateBlockId(prefix)`: Generates short collision-resistant IDs (`act_...`, `cond_...`, `trg_...`, `br_...`).
- `regenerateBranchIds(branch, markAsCopy)`: Duplicates a `ChoiceBranch`, appending `(Copy)` to `label` if requested, and recursively regenerates IDs for all conditions and sequence actions.
- `convertTriggerToCondition(trigger)` & `convertConditionToTrigger(condition)`: Converts triggers to conditions and vice-versa, mapping `trigger.to` to `condition.state` / `condition.value`.
- `cloneRuleWithNewIds(rule)`: Clones an entire automation rule with fresh IDs on all components.

### 3. Builder State & Actions (`frontend/src/components/AutomationBuilder.tsx`)
- `clipboard` state initialized from `sessionStorage.getItem('can_do_automation_clipboard_v1')`.
- `copyToClipboard(type, data, label)` syncing to `sessionStorage` and `navigator.clipboard`.
- `getClonedClipboardPayload(targetType)` providing ready-to-insert objects with fresh IDs.
- Choose Card actions: `duplicateBranch(idx)`, `moveBranch(idx, direction)`, and inline label editing.

---

## 5. Execution Order

Upon user confirmation to proceed:
1. Update `frontend/src/types/automation.ts` with new schemas and clipboard interfaces.
2. Add cloning, ID regeneration, and cross-type conversion utilities to `frontend/src/utils/automationConverters.ts`.
3. Add comprehensive unit tests in `frontend/src/utils/automationConverters.test.ts` and run tests.
4. Integrate the clipboard state, Choose Card duplicate/reorder/label controls, and cross-type paste buttons in `frontend/src/components/AutomationBuilder.tsx`.
5. Add `cycle_entity` card rendering to `AutomationBuilder.tsx`.
6. Verify clean applet compilation and runtime functionality.
