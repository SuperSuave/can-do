import { Command, CommandOption, CommandStep } from '../types/catalog';

export interface CanCaptureParsedResult {
  command: Partial<Command>;
  rawText: string;
  inferredName: string;
  category: string;
  subcategory: string;
  commandCanId?: string;
  stateCanId?: string;
  statesFound: {
    stateName: string;
    commandBytes?: { byteIndex: number; byteNum: number; hex: string; repeat?: number }[];
    stateBytes?: { byteIndex: number; byteNum: number; hex: string }[];
  }[];
  warning?: string;
}

/**
 * Builds an 8-byte payload mask (e.g. "* * * * * F8 * *") given a specific byte number (1-8) and hex.
 * Default wildcard is '*' for unconstrained bytes.
 */
export function buildPayloadFromByte(
  byteNum: number, // 1 to 8 (D1 to D8)
  hex: string,
  baseFill: string = '*'
): string {
  const bytes = Array(8).fill(baseFill);
  const idx = Math.max(0, Math.min(7, byteNum - 1));
  bytes[idx] = hex.toUpperCase().padStart(2, '0');
  return bytes.join(' ');
}

/**
 * Given multiple byte modifications for a step, merges them into an 8-byte payload.
 */
export function buildPayloadFromMultiBytes(
  modifications: { byteNum: number; hex: string }[],
  baseFill: string = '*'
): string {
  const bytes = Array(8).fill(baseFill);
  modifications.forEach(m => {
    const idx = Math.max(0, Math.min(7, m.byteNum - 1));
    bytes[idx] = m.hex.toUpperCase().padStart(2, '0');
  });
  return bytes.join(' ');
}

/**
 * Formats a command or option into the community !cancapture note style.
 */
export function formatCommandAsCanCapture(command: Command): string {
  const lines: string[] = [];
  lines.push('!cancapture');
  
  const cmdCanId = command.action_can_id || '0x???';
  const stateCanId = command.state_can_id || '0x???';

  const formatPayloadToNotation = (canId: string, payload?: string | Record<string, string>, repeat?: number) => {
    if (!payload) return '';
    if (typeof payload === 'object') {
      const byteDesc = Object.entries(payload).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `${canId} ${byteDesc}${repeat && repeat > 1 ? ` x${repeat}` : ''}`;
    }
    const bytes = payload.split(/\s+/);
    const nonWildcardBytes = bytes
      .map((b, i) => ({ b, d: `D${i + 1}` }))
      .filter(item => item.b !== '*' && !item.b.includes('*'));

    if (nonWildcardBytes.length > 0) {
      const byteDesc = nonWildcardBytes.map(n => `${n.d}: ${n.b}`).join(', ');
      return `${canId} ${byteDesc}${repeat && repeat > 1 ? ` x${repeat}` : ''}`;
    } else {
      return `${canId}: ${payload}${repeat && repeat > 1 ? ` x${repeat}` : ''}`;
    }
  };

  if (command.options && command.options.length > 0) {
    lines.push(`${command.name}: frame ID ${cmdCanId}(command) & ${stateCanId}(state)\n`);

    command.options.forEach(opt => {
      // Option Command steps
      lines.push(`${opt.label} Command:`);
      if (opt.steps && opt.steps.length > 0) {
        opt.steps.forEach(st => {
          lines.push(formatPayloadToNotation(opt.action_can_id || cmdCanId, st.payload, st.repeat));
        });
      } else if (opt.payload || opt.to_payload) {
        lines.push(formatPayloadToNotation(opt.action_can_id || cmdCanId, opt.payload || opt.to_payload));
      }

      // Option State
      const statePayload = opt.match_payload || opt.to_payload || opt.from_payload;
      if (statePayload) {
        lines.push(`${opt.label} State:`);
        lines.push(formatPayloadToNotation(opt.state_can_id || stateCanId, statePayload));
      }

      lines.push('');
    });
  } else {
    // Single command
    lines.push(`${command.name}: frame ID ${cmdCanId}\n`);
    if (command.steps && command.steps.length > 0) {
      lines.push('Command Sequence:');
      command.steps.forEach(st => {
        lines.push(formatPayloadToNotation(cmdCanId, st.payload, st.repeat));
      });
    } else {
      if (command.match_payload) {
        lines.push(`State:`);
        lines.push(formatPayloadToNotation(stateCanId, command.match_payload));
      }
      if (command.from_payload && command.to_payload) {
        lines.push(`Trigger From:`);
        lines.push(formatPayloadToNotation(cmdCanId, command.from_payload));
        lines.push(`Trigger To:`);
        lines.push(formatPayloadToNotation(cmdCanId, command.to_payload));
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Parses unstructured or formatted !cancapture notes into a full Catalog Command.
 */
export function parseCanCaptureNote(rawInput: string): CanCaptureParsedResult {
  const text = rawInput.trim();
  const cleanLines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

  const lines = cleanLines
    .map((l, idx) => {
      if (idx === 0 && l.toLowerCase().startsWith('!cancapture')) {
        return l.replace(/^!cancapture\s*/i, '').trim();
      }
      return l;
    })
    .filter(l => l.length > 0);

  let inferredName = 'Custom Captured Command';
  let commandCanId = '';
  let stateCanId = '';

  // 1. Check first line for title and Frame IDs
  // e.g., "Rear Right Seat Comfort: frame ID 0x4A2(command) & 0x453(state)"
  // or "Driver Seat: 0x4A2 (cmd) 0x453 (state)"
  if (lines.length > 0) {
    const firstLine = lines[0];
    
    // Look for Title: ...
    const colonSplit = firstLine.split(':');
    if (colonSplit.length > 1 && !colonSplit[0].toLowerCase().includes('0x')) {
      inferredName = colonSplit[0].trim();
    }

    // Extract frame IDs with labels
    // Pattern: 0x[0-9A-Fa-f]+(?: \((?:command|cmd)\))?
    const hexIds = firstLine.match(/0x[0-9A-Fa-f]{1,4}/gi) || [];
    
    // Check for explicit (command) vs (state) tags in firstLine
    const cmdMatch = firstLine.match(/(0x[0-9A-Fa-f]{1,4})\s*\(\s*(?:command|cmd|tx|act)\s*\)/i);
    const stateMatch = firstLine.match(/(0x[0-9A-Fa-f]{1,4})\s*\(\s*(?:state|status|rx|trig|cond)\s*\)/i);

    if (cmdMatch) commandCanId = cmdMatch[1].toLowerCase();
    if (stateMatch) stateCanId = stateMatch[1].toLowerCase();

    // Fallbacks if not tagged explicitly
    if (!commandCanId && hexIds.length > 0) commandCanId = hexIds[0].toLowerCase();
    if (!stateCanId && hexIds.length > 1) stateCanId = hexIds[1].toLowerCase();
  }

  // 2. State & Command extraction state machine
  // We look for patterns like:
  // "High Command", "High State:", "Low Command", "Off Command"
  interface StateCollector {
    stateName: string;
    cmdSteps: { payload: string; repeat?: number }[];
    statePayload?: string;
    stateCanId?: string;
    cmdCanId?: string;
  }

  const stateCollectors: Map<string, StateCollector> = new Map();
  let currentTargetState = 'General';
  let currentTargetSection: 'command' | 'state' | 'unknown' = 'unknown';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line specifies a state/mode heading:
    // e.g., "High Command", "20% Command", "High State:"
    const headingMatch = line.match(/^([A-Za-z0-9\s/%_-]+?)\s*(?:(Command|State|Action|Condition|Trigger))?:?$/i);
    const isJustHeader = headingMatch && !line.includes('0x') && !line.toUpperCase().includes('D1') && !line.toUpperCase().includes('D6');

    if (isJustHeader && headingMatch) {
      const namePart = headingMatch[1].trim();
      const typePart = headingMatch[2]?.toLowerCase();

      // Keep the full state/mode name intact (e.g. "High Cool", "High Heat", "Off", etc.)
      let detectedState = namePart;
      currentTargetState = detectedState;
      if (typePart === 'command' || typePart === 'action') {
        currentTargetSection = 'command';
      } else if (typePart === 'state' || typePart === 'condition' || typePart === 'trigger') {
        currentTargetSection = 'state';
      } else {
        currentTargetSection = 'unknown';
      }

      if (!stateCollectors.has(currentTargetState)) {
        stateCollectors.set(currentTargetState, {
          stateName: currentTargetState,
          cmdSteps: []
        });
      }
      continue;
    }

    // Parse lines containing CAN IDs and D1-D8 references
    // e.g.: "0x4A2 D6: F8 x3" or "0x453 D1: 41" or "0x4A2: D6: FF" or "0x4A2 D1: 00 D6: F8"
    const canIdMatch = line.match(/0x[0-9A-Fa-f]{1,4}/i);
    const lineCanId = canIdMatch ? canIdMatch[0].toLowerCase() : '';

    // Match D1 through D8 byte statements: D[1-8]:?\s*([0-9A-Fa-f]{2})
    const dMatches: { byteNum: number; hex: string }[] = [];
    const dRegex = /D([1-8])\s*[:=]?\s*([0-9A-Fa-f]{1,2})/gi;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = dRegex.exec(line)) !== null) {
      dMatches.push({
        byteNum: parseInt(dMatch[1], 10),
        hex: dMatch[2].padStart(2, '0').toUpperCase()
      });
    }

    // Check repeat count: match " x3", " * 3", or " x 3" at word boundaries, avoiding 0x
    const repeatMatch = line.match(/(?:\bx\s*|\*\s*|\brepeat\s+)(\d+)/i);
    const repeat = repeatMatch ? parseInt(repeatMatch[1], 10) : undefined;

    if (dMatches.length > 0) {
      // If we don't have global commandCanId or stateCanId yet, assign from first occurrences
      if (lineCanId) {
        if (currentTargetSection === 'state' && !stateCanId) stateCanId = lineCanId;
        if (currentTargetSection === 'command' && !commandCanId) commandCanId = lineCanId;
      }

      // Check if this line is a command step or a state match
      const isStateLine =
        currentTargetSection === 'state' ||
        (lineCanId && stateCanId && lineCanId === stateCanId) ||
        line.toLowerCase().includes('state');

      if (!stateCollectors.has(currentTargetState)) {
        stateCollectors.set(currentTargetState, {
          stateName: currentTargetState,
          cmdSteps: []
        });
      }
      const collector = stateCollectors.get(currentTargetState)!;

      if (isStateLine) {
        // State payload matching
        const statePayload = buildPayloadFromMultiBytes(dMatches, '*');
        collector.statePayload = statePayload;
        collector.stateCanId = lineCanId || stateCanId;
        if (!stateCanId && lineCanId) stateCanId = lineCanId;
      } else {
        // Command pulse/action step
        const stepPayload = buildPayloadFromMultiBytes(dMatches, '*');
        collector.cmdSteps.push({
          payload: stepPayload,
          repeat: repeat && repeat > 1 ? repeat : undefined
        });
        collector.cmdCanId = lineCanId || commandCanId;
        if (!commandCanId && lineCanId) commandCanId = lineCanId;
      }
    } else if (line.includes('*') || /([0-9A-Fa-f]{2}\s+){3,}/.test(line)) {
      // Direct raw 8-byte payload line (e.g., "0x4A2: 00 00 00 00 00 F8 00 00")
      const rawHexTokens = line.split(/[:\s]+/).filter(t => /^[0-9A-Fa-f]{2}$|^\*$/.test(t));
      if (rawHexTokens.length >= 4) {
        const fullPayload = rawHexTokens.slice(0, 8).join(' ');
        if (!stateCollectors.has(currentTargetState)) {
          stateCollectors.set(currentTargetState, {
            stateName: currentTargetState,
            cmdSteps: []
          });
        }
        const collector = stateCollectors.get(currentTargetState)!;
        if (currentTargetSection === 'state') {
          collector.statePayload = fullPayload;
        } else {
          collector.cmdSteps.push({ payload: fullPayload, repeat });
        }
      }
    }
  }

  // Derive Category & Subcategory based on name
  let category = 'Comfort & Climate';
  let subcategory = 'Seats & Steering Wheel Comfort';
  const lowerTitle = inferredName.toLowerCase();
  if (lowerTitle.includes('seat')) {
    category = 'Comfort & Climate';
    subcategory = lowerTitle.includes('driver')
      ? 'Driver Seat Comfort'
      : lowerTitle.includes('passenger') || lowerTitle.includes('pass')
      ? 'Passenger Seat Comfort'
      : lowerTitle.includes('rear right')
      ? 'Rear Right Seat Comfort'
      : lowerTitle.includes('rear left')
      ? 'Rear Left Seat Comfort'
      : 'Seats & Steering Wheel Comfort';
  } else if (lowerTitle.includes('steering') || lowerTitle.includes('wheel')) {
    category = 'Steering Wheel';
    subcategory = 'Steering Wheel Comfort';
  } else if (lowerTitle.includes('cluster') || lowerTitle.includes('nav') || lowerTitle.includes('menu')) {
    category = 'Steering Wheel';
    subcategory = 'Cluster & Menu Navigation';
  } else if (lowerTitle.includes('audio') || lowerTitle.includes('media') || lowerTitle.includes('volume')) {
    category = 'Steering Wheel';
    subcategory = 'Media & Audio Controls';
  }

  // Generate unique ID slug
  const idSlug = inferredName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Build Command Options if states were parsed
  const options: CommandOption[] = [];
  const stateKeys = Array.from(stateCollectors.keys());

  // Order options logically: Off first, then Low, Med, High (or preserve order)
  const orderWeight = (s: string) => {
    const l = s.toLowerCase();
    if (l.includes('off')) return 0;
    if (l.includes('low') || l.includes('level 1') || l === '1') return 1;
    if (l.includes('med') || l.includes('mid') || l.includes('medium') || l.includes('level 2') || l === '2') return 2;
    if (l.includes('high') || l.includes('level 3') || l === '3') return 3;
    return 10;
  };

  const sortedStateKeys = stateKeys.sort((a, b) => orderWeight(a) - orderWeight(b));

  sortedStateKeys.forEach(k => {
    const data = stateCollectors.get(k)!;
    const opt: CommandOption = {
      label: data.stateName,
      popup: `${inferredName}: ${data.stateName}`
    };
    if (data.cmdSteps.length > 0) {
      opt.steps = data.cmdSteps;
    }
    if (data.statePayload) {
      opt.match_payload = data.statePayload;
      opt.to_payload = data.statePayload;
    }
    if (k.toLowerCase() === 'off') {
      opt.default = true;
    }
    options.push(opt);
  });

  const parsedCommand: Partial<Command> = {
    id: idSlug || 'custom_capture_cmd',
    name: inferredName,
    category,
    subcategory,
    roles: ['action', 'condition'],
    state_can_id: stateCanId || '0x496',
    action_can_id: commandCanId || '0x4A2',
    bus: 0,
    action_bus: 0,
    tags: []
  };

  if (options.length > 0) {
    parsedCommand.options = options;
  }

  return {
    command: parsedCommand,
    rawText: rawInput,
    inferredName,
    category,
    subcategory,
    commandCanId,
    stateCanId,
    statesFound: sortedStateKeys.map(k => {
      const data = stateCollectors.get(k)!;
      return {
        stateName: data.stateName
      };
    })
  };
}
