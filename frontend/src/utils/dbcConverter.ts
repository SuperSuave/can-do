import { Catalog, Command, CommandOption, CommandRole, ContributorInfo, Vehicle } from '../types/catalog';

export interface DbcExportOptions {
  vehicleId?: string;
  category?: string;
  ecuName?: string;
  includeComments?: boolean;
}

export interface DbcParseStats {
  messageCount: number;
  signalCount: number;
  valueTableCount: number;
  commentCount: number;
}

export interface DbcSignal {
  name: string;
  startBit: number;
  length: number;
  isLittleEndian: boolean;
  isSigned: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  receivers: string[];
  comment?: string;
  values?: Record<number, string>;
}

export interface DbcMessage {
  id: number;
  name: string;
  dlc: number;
  transmitter: string;
  isExtended: boolean;
  comment?: string;
  signals: DbcSignal[];
}

/**
 * Normalizes CAN ID to numeric decimal and extended flag
 * e.g. "0x448" -> 1096, isExtended: false
 * "0x18DAF110" -> 416997648, isExtended: true
 */
export function parseCanIdString(canIdStr?: string): { id: number; isExtended: boolean } {
  if (!canIdStr) return { id: 0, isExtended: false };
  const clean = canIdStr.trim();
  let num = 0;
  if (clean.toLowerCase().startsWith('0x')) {
    num = parseInt(clean.slice(2), 16);
  } else {
    num = parseInt(clean, 10);
  }

  if (isNaN(num)) num = 0;
  // If > 0x7FF (2047), it's a 29-bit extended ID
  const isExtended = num > 0x7FF || clean.length > 5;
  return { id: num, isExtended };
}

/**
 * Formats a numeric CAN ID into standard hex string like "0x448" or "0x18DAF110"
 */
export function formatCanIdToHex(id: number, isExtended: boolean = false): string {
  const hex = id.toString(16).toUpperCase();
  return `0x${hex}`;
}

/**
 * Derives bit offset and length from CAN Do payload strings
 */
export function deriveSignalBitRange(
  fromPayload?: string,
  toPayload?: string,
  matchPayload?: string
): { startBit: number; length: number; idleVal: number; activeVal: number } {
  const fromTokens = (fromPayload || '').trim().split(/\s+/).filter(Boolean);
  const toTokens = (toPayload || '').trim().split(/\s+/).filter(Boolean);
  const matchTokens = (matchPayload || '').trim().split(/\s+/).filter(Boolean);

  // 1. Compare from and to payloads
  if (fromTokens.length > 0 && toTokens.length > 0) {
    const maxLen = Math.max(fromTokens.length, toTokens.length);
    for (let i = 0; i < maxLen; i++) {
      const fByte = fromTokens[i] || '*';
      const tByte = toTokens[i] || '*';

      if (fByte !== tByte) {
        // Check if high nibble differs
        const fHi = fByte[0];
        const tHi = tByte[0];
        const fLo = fByte[1];
        const tLo = tByte[1];

        if (fHi !== tHi && fLo === tLo) {
          // High nibble: startBit = i * 8 + 4, length = 4
          const vF = fHi !== '*' ? parseInt(fHi, 16) || 0 : 0;
          const vT = tHi !== '*' ? parseInt(tHi, 16) || 1 : 1;
          return { startBit: i * 8 + 4, length: 4, idleVal: vF, activeVal: vT };
        } else if (fHi === tHi && fLo !== tLo) {
          // Low nibble: startBit = i * 8, length = 4
          const vF = fLo !== '*' ? parseInt(fLo, 16) || 0 : 0;
          const vT = tLo !== '*' ? parseInt(tLo, 16) || 1 : 1;
          return { startBit: i * 8, length: 4, idleVal: vF, activeVal: vT };
        } else {
          // Full byte
          const vF = fByte !== '*' && !fByte.includes('*') ? parseInt(fByte, 16) || 0 : 0;
          const vT = tByte !== '*' && !tByte.includes('*') ? parseInt(tByte, 16) || 1 : 1;
          return { startBit: i * 8, length: 8, idleVal: vF, activeVal: vT };
        }
      }
    }
  }

  // 2. Check match payload
  if (matchTokens.length > 0) {
    for (let i = 0; i < matchTokens.length; i++) {
      const m = matchTokens[i];
      if (m !== '*' && m !== '**') {
        const hi = m[0];
        const lo = m[1];
        if (hi !== '*' && lo === '*') {
          return { startBit: i * 8 + 4, length: 4, idleVal: 0, activeVal: parseInt(hi, 16) || 1 };
        } else if (hi === '*' && lo !== '*') {
          return { startBit: i * 8, length: 4, idleVal: 0, activeVal: parseInt(lo, 16) || 1 };
        } else {
          return { startBit: i * 8, length: 8, idleVal: 0, activeVal: parseInt(m, 16) || 1 };
        }
      }
    }
  }

  // Default fallback to byte 0
  return { startBit: 0, length: 8, idleVal: 0, activeVal: 1 };
}

/**
 * Creates a clean DBC identifier (alphanumeric + underscore)
 */
export function sanitizeDbcIdentifier(name: string): string {
  let cleaned = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleaned) cleaned = 'CMD_SIGNAL';
  // DBC signal / message names cannot start with a digit
  if (/^[0-9]/.test(cleaned)) {
    cleaned = 'SIG_' + cleaned;
  }
  return cleaned;
}

/**
 * Converts a list of CAN Do commands into a Vector CAN DBC string
 */
export function exportToDbc(catalog: Catalog, options: DbcExportOptions = {}): string {
  const ecu = sanitizeDbcIdentifier(options.ecuName || 'CAN_DO_HUB');
  let commands = catalog.commands;

  // Filter by category if requested
  if (options.category && options.category !== 'all') {
    commands = commands.filter(c => c.category === options.category);
  }

  // Filter by vehicle if requested
  if (options.vehicleId && options.vehicleId !== 'all') {
    const vehicle = catalog.vehicles.find(v => v.id === options.vehicleId);
    if (vehicle) {
      commands = commands.filter(c => {
        if (c.requires_feature && !vehicle.features.includes(c.requires_feature)) return false;
        if (c.tags && c.tags.length > 0) {
          return c.tags.some(t => vehicle.id.includes(t) || vehicle.family.includes(t));
        }
        return true;
      });
    }
  }

  // Group commands by can_id
  const messageGroups = new Map<string, Command[]>();
  commands.forEach(cmd => {
    const canId = cmd.state_can_id ? cmd.state_can_id.toLowerCase().trim() : '0x000';
    if (!messageGroups.has(canId)) {
      messageGroups.set(canId, []);
    }
    messageGroups.get(canId)!.push(cmd);
  });

  const lines: string[] = [];

  // DBC Standard Header
  lines.push('VERSION ""');
  lines.push('');
  lines.push('NS_ :');
  lines.push('  NS_DESC_');
  lines.push('  CM_');
  lines.push('  BA_DEF_');
  lines.push('  BA_');
  lines.push('  VAL_');
  lines.push('  CAT_DEF_');
  lines.push('  CAT_');
  lines.push('  FILTER');
  lines.push('  BA_DEF_DEF_');
  lines.push('  EV_DATA_');
  lines.push('  ENVVAR_DATA_');
  lines.push('  SGTYPE_');
  lines.push('  SGTYPE_VAL_');
  lines.push('  BA_DEF_SGTYPE_');
  lines.push('  BA_SGTYPE_');
  lines.push('  SIG_TYPE_REF_');
  lines.push('  VAL_TABLE_');
  lines.push('  SIG_GROUP_');
  lines.push('  SIG_VALTYPE_');
  lines.push('  SIGTYPE_VALTYPE_');
  lines.push('  BO_TX_BU_');
  lines.push('  BA_DEF_REL_');
  lines.push('  BA_REL_');
  lines.push('  BA_DEF_DEF_REL_');
  lines.push('  BU_SG_REL_');
  lines.push('  BU_EV_REL_');
  lines.push('  BU_BO_REL_');
  lines.push('  SG_MUL_VAL_');
  lines.push('');
  lines.push(`BS_:`);
  lines.push('');
  lines.push(`BU_: ${ecu} ECU TESTER`);
  lines.push('');

  const valueTableLines: string[] = [];
  const commentLines: string[] = [];

  // Global catalog comment
  commentLines.push(
    `CM_ "CAN Do Catalog v${catalog.catalog_version} DBC Export - Total Commands: ${commands.length} - Generated by CAN Do Message Catalog Hub";`
  );

  // Process each message
  messageGroups.forEach((cmds, canIdHex) => {
    const { id: rawNum, isExtended } = parseCanIdString(canIdHex);
    // In Vector DBC standard, 29-bit extended IDs have bit 31 set (0x80000000)
    const dbcMessageId = isExtended ? (rawNum | 0x80000000) >>> 0 : rawNum;

    // Pick a representative message name from category and first command
    const primaryCmd = cmds[0];
    const categoryName = primaryCmd.category || 'CAN_MESSAGE';
    const msgName = sanitizeDbcIdentifier(`${categoryName}_${canIdHex.replace(/^0x/, '')}`);

    // DLC defaults to 8 bytes for automotive CAN
    const dlc = 8;
    lines.push(`BO_ ${dbcMessageId} ${msgName}: ${dlc} ECU`);

    if (options.includeComments !== false) {
      commentLines.push(
        `CM_ BO_ ${dbcMessageId} "Category: ${categoryName} | Bus: ${primaryCmd.bus ?? 0} | CAN ID: ${canIdHex}";`
      );
    }

    const usedSignalNames = new Set<string>();

    cmds.forEach(cmd => {
      let baseSigName = sanitizeDbcIdentifier(cmd.id || cmd.name);
      if (usedSignalNames.has(baseSigName)) {
        baseSigName = `${baseSigName}_${usedSignalNames.size + 1}`;
      }
      usedSignalNames.add(baseSigName);

      const { startBit, length, idleVal, activeVal } = deriveSignalBitRange(
        cmd.from_payload,
        cmd.to_payload,
        cmd.match_payload
      );

      // Signal line: SG_ <Name> : <StartBit>|<Length>@1+ (1,0) [min|max] "" <Receivers>
      const maxVal = Math.pow(2, length) - 1;
      lines.push(` SG_ ${baseSigName} : ${startBit}|${length}@1+ (1,0) [0|${maxVal}] "" ${ecu}`);

      // Generate Value Table (VAL_)
      if (cmd.options && cmd.options.length > 0) {
        const valPairs = cmd.options
          .map((opt, idx) => {
            let hexStr = '';
            if (opt.payload) {
              hexStr = typeof opt.payload === 'string' 
                ? opt.payload.replace(/[^0-9A-Fa-f]/g, '')
                : Object.values(opt.payload).map(v => v.replace(/[^0-9A-Fa-f]/g, '')).join('');
            }
            const optVal = hexStr ? parseInt(hexStr, 16) || idx : idx;
            const cleanLabel = opt.label.replace(/"/g, "'");
            return `${optVal} "${cleanLabel}"`;
          })
          .join(' ');

        valueTableLines.push(`VAL_ ${dbcMessageId} ${baseSigName} ${valPairs} ;`);
      } else {
        // Binary press / active state
        valueTableLines.push(
          `VAL_ ${dbcMessageId} ${baseSigName} ${idleVal} "INACTIVE" ${activeVal} "ACTIVE" ;`
        );
      }

      // Generate Signal Comments (CM_ SG_)
      if (options.includeComments !== false) {
        const descParts: string[] = [];
        descParts.push(`Command: ${cmd.name} (${cmd.id})`);
        descParts.push(`Roles: ${cmd.roles.join(',')}`);
        if (cmd.requires_feature) descParts.push(`Requires: ${cmd.requires_feature}`);
        if (cmd.contributor?.github) descParts.push(`Author: @${cmd.contributor.github.replace(/^@/, '')}`);
        else if (cmd.contributor?.name) descParts.push(`Author: ${cmd.contributor.name}`);
        if (cmd.contributor?.notes) descParts.push(`Notes: ${cmd.contributor.notes}`);

        const commentText = descParts.join(' | ').replace(/"/g, "'");
        commentLines.push(`CM_ SG_ ${dbcMessageId} ${baseSigName} "${commentText}";`);
      }
    });

    lines.push('');
  });

  // Append Comments and Value Tables
  if (commentLines.length > 0) {
    lines.push('// Comments & Annotations');
    commentLines.forEach(c => lines.push(c));
    lines.push('');
  }

  if (valueTableLines.length > 0) {
    lines.push('// Value Tables');
    valueTableLines.forEach(v => lines.push(v));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates an isolated DBC snippet for a single command
 */
export function exportCommandToDbcSnippet(command: Command): string {
  const canIdHex = command.state_can_id || '0x448';
  const { id: rawNum, isExtended } = parseCanIdString(canIdHex);
  const dbcMessageId = isExtended ? (rawNum | 0x80000000) >>> 0 : rawNum;
  const msgName = sanitizeDbcIdentifier(`${command.category}_${canIdHex.replace(/^0x/, '')}`);
  const sigName = sanitizeDbcIdentifier(command.id || command.name);

  const { startBit, length, idleVal, activeVal } = deriveSignalBitRange(
    command.from_payload,
    command.to_payload,
    command.match_payload
  );

  const maxVal = Math.pow(2, length) - 1;
  const lines: string[] = [];

  lines.push(`BO_ ${dbcMessageId} ${msgName}: 8 ECU`);
  lines.push(` SG_ ${sigName} : ${startBit}|${length}@1+ (1,0) [0|${maxVal}] "" CAN_DO_HUB`);

  if (command.options && command.options.length > 0) {
    const valPairs = command.options
      .map((opt, idx) => {
        let hexStr = '';
        if (opt.payload) {
          hexStr = typeof opt.payload === 'string'
            ? opt.payload.replace(/[^0-9A-Fa-f]/g, '')
            : Object.values(opt.payload).map(v => v.replace(/[^0-9A-Fa-f]/g, '')).join('');
        }
        const val = hexStr ? parseInt(hexStr, 16) || idx : idx;
        return `${val} "${opt.label.replace(/"/g, "'")}"`;
      })
      .join(' ');
    lines.push(`VAL_ ${dbcMessageId} ${sigName} ${valPairs} ;`);
  } else {
    lines.push(`VAL_ ${dbcMessageId} ${sigName} ${idleVal} "INACTIVE" ${activeVal} "ACTIVE" ;`);
  }

  const commentParts: string[] = [`Command: ${command.name}`, `Category: ${command.category}`];
  if (command.contributor?.github) {
    commentParts.push(`Author: @${command.contributor.github.replace(/^@/, '')}`);
  }
  lines.push(`CM_ SG_ ${dbcMessageId} ${sigName} "${commentParts.join(' | ')}";`);

  return lines.join('\n');
}

/**
 * Parses raw DBC file contents into CAN Do catalog commands
 */
export function parseDbc(dbcContent: string): {
  catalog: Catalog;
  stats: DbcParseStats;
  issues: string[];
} {
  const issues: string[] = [];
  const lines = dbcContent.split(/\r?\n/);

  const messages = new Map<number, DbcMessage>();
  let currentMessage: DbcMessage | null = null;

  // Regex patterns for standard Vector DBC tokens
  // BO_ 1096 STEERING_BUTTONS: 8 ECU
  const boRegex = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+([A-Za-z0-9_]+)/;
  // SG_ STAR_BTN : 44|4@1+ (1,0) [0|15] "" ECU
  const sgRegex = /^SG_\s+([A-Za-z0-9_]+)\s*(?:M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s+\(([0-9.eE+-]+),([0-9.eE+-]+)\)\s+\[([0-9.eE+-]+)\|([0-9.eE+-]+)\]\s+"([^"]*)"\s+([A-Za-z0-9_,\s]*)/;
  // VAL_ 1096 STAR_BTN 0 "OFF" 1 "PRESSED" ;
  const valRegex = /^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.+?)\s*;/;
  // CM_ BO_ 1096 "comment"
  const cmBoRegex = /^CM_\s+BO_\s+(\d+)\s+"([^"]*)"\s*;/;
  // CM_ SG_ 1096 STAR_BTN "comment"
  const cmSgRegex = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z0-9_]+)\s+"([^"]*)"\s*;/;

  let valueTableCount = 0;
  let commentCount = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // 1. Message Definition (BO_)
    const boMatch = trimmed.match(boRegex);
    if (boMatch) {
      const idRaw = parseInt(boMatch[1], 10);
      const isExtended = (idRaw & 0x80000000) !== 0 || idRaw > 0x7ff;
      // Mask off 0x80000000 bit 31 if extended
      const cleanId = (idRaw & 0x1fffffff) >>> 0;

      currentMessage = {
        id: cleanId,
        name: boMatch[2],
        dlc: parseInt(boMatch[3], 10) || 8,
        transmitter: boMatch[4],
        isExtended,
        signals: []
      };

      messages.set(cleanId, currentMessage);
      continue;
    }

    // 2. Signal Definition (SG_)
    const sgMatch = trimmed.match(sgRegex);
    if (sgMatch && currentMessage) {
      const sig: DbcSignal = {
        name: sgMatch[1],
        startBit: parseInt(sgMatch[2], 10),
        length: parseInt(sgMatch[3], 10),
        isLittleEndian: sgMatch[4] === '1',
        isSigned: sgMatch[5] === '-',
        factor: parseFloat(sgMatch[6]) || 1,
        offset: parseFloat(sgMatch[7]) || 0,
        min: parseFloat(sgMatch[8]) || 0,
        max: parseFloat(sgMatch[9]) || 1,
        unit: sgMatch[10] || '',
        receivers: (sgMatch[11] || '').split(/\s+/).filter(Boolean)
      };
      currentMessage.signals.push(sig);
      continue;
    }

    // 3. Value Table Definition (VAL_)
    const valMatch = trimmed.match(valRegex);
    if (valMatch) {
      valueTableCount++;
      const idRaw = parseInt(valMatch[1], 10);
      const cleanId = (idRaw & 0x1fffffff) >>> 0;
      const sigName = valMatch[2];
      const rest = valMatch[3];

      const msg = messages.get(cleanId);
      if (msg) {
        const sig = msg.signals.find(s => s.name === sigName);
        if (sig) {
          sig.values = sig.values || {};
          // Parse value pairs: e.g. 0 "OFF" 1 "ON"
          const pairRegex = /(\d+)\s+"([^"]*)"/g;
          let pairMatch;
          while ((pairMatch = pairRegex.exec(rest)) !== null) {
            sig.values[parseInt(pairMatch[1], 10)] = pairMatch[2];
          }
        }
      }
      continue;
    }

    // 4. Comments (CM_)
    const cmSgMatch = trimmed.match(cmSgRegex);
    if (cmSgMatch) {
      commentCount++;
      const cleanId = (parseInt(cmSgMatch[1], 10) & 0x1fffffff) >>> 0;
      const sigName = cmSgMatch[2];
      const comment = cmSgMatch[3];
      const msg = messages.get(cleanId);
      if (msg) {
        const sig = msg.signals.find(s => s.name === sigName);
        if (sig) sig.comment = comment;
      }
      continue;
    }

    const cmBoMatch = trimmed.match(cmBoRegex);
    if (cmBoMatch) {
      commentCount++;
      const cleanId = (parseInt(cmBoMatch[1], 10) & 0x1fffffff) >>> 0;
      const comment = cmBoMatch[2];
      const msg = messages.get(cleanId);
      if (msg) msg.comment = comment;
      continue;
    }
  }

  // Convert parsed DBC messages & signals into CAN Do Commands
  const generatedCommands: Command[] = [];
  let totalSignals = 0;

  messages.forEach(msg => {
    const canIdHex = formatCanIdToHex(msg.id, msg.isExtended);
    const category = inferCategoryFromMessage(msg.name);

    msg.signals.forEach(sig => {
      totalSignals++;
      const cmdId = sanitizeCommandId(sig.name);
      const friendlyName = humanizeSignalName(sig.name);

      // Extract author/contributor from comment if present
      let contributor: ContributorInfo | undefined = undefined;
      let notes: string | undefined = undefined;
      if (sig.comment) {
        const authorMatch = sig.comment.match(/Author:\s*@?([A-Za-z0-9_-]+)/i);
        const notesMatch = sig.comment.match(/Notes:\s*([^|;]+)/i);
        if (authorMatch) {
          contributor = {
            github: authorMatch[1].trim(),
            notes: notesMatch ? notesMatch[1].trim() : undefined
          };
        } else if (notesMatch) {
          notes = notesMatch[1].trim();
        }
      }

      // Generate CAN Do payload masks from startBit and length
      const byteIndex = Math.floor(sig.startBit / 8);
      const bitInByte = sig.startBit % 8;
      const dlc = Math.max(msg.dlc || 8, byteIndex + 1);

      // Create payload byte arrays with '*' wildcards
      const fromBytes = Array(dlc).fill('*');
      const toBytes = Array(dlc).fill('*');

      let optionsList: CommandOption[] | undefined = undefined;

      if (sig.values && Object.keys(sig.values).length > 0) {
        optionsList = Object.entries(sig.values).map(([valStr, label], idx) => {
          const valNum = parseInt(valStr, 10);
          const optBytes = Array(dlc).fill('*');

          if (sig.length <= 4) {
            // Nibble mask
            const hexNibble = (valNum & 0xf).toString(16).toUpperCase();
            optBytes[byteIndex] = bitInByte >= 4 ? `${hexNibble}*` : `*${hexNibble}`;
          } else {
            // Full byte or larger
            optBytes[byteIndex] = (valNum & 0xff).toString(16).toUpperCase().padStart(2, '0');
          }

          return {
            label,
            payload: optBytes.join(' '),
            default: idx === 0
          };
        });
      }

      // Standard transition masks
      if (sig.length <= 4) {
        if (bitInByte >= 4) {
          fromBytes[byteIndex] = '0*';
          toBytes[byteIndex] = '1*';
        } else {
          fromBytes[byteIndex] = '*0';
          toBytes[byteIndex] = '*1';
        }
      } else {
        fromBytes[byteIndex] = '00';
        toBytes[byteIndex] = '01';
      }

      const roles: CommandRole[] = ['trigger'];
      if (sig.name.toLowerCase().includes('status') || sig.name.toLowerCase().includes('state')) {
        roles.push('condition');
      }

      const cmd: Command = {
        id: cmdId,
        name: friendlyName,
        category,
        state_can_id: canIdHex,
        bus: 0,
        roles,
        from_payload: fromBytes.join(' '),
        to_payload: toBytes.join(' '),
        tags: [category.toLowerCase().replace(/[^a-z0-9]+/g, '_')],
        options: optionsList,
        contributor
      };

      if (notes) {
        cmd.popup_message = notes;
      }

      generatedCommands.push(cmd);
    });
  });

  const parsedCatalog: Catalog = {
    catalog_version: '3.1.0',
    vehicles: [],
    commands: generatedCommands
  };

  return {
    catalog: parsedCatalog,
    stats: {
      messageCount: messages.size,
      signalCount: totalSignals,
      valueTableCount,
      commentCount
    },
    issues
  };
}

/**
 * Infers a clean CAN Do category name from DBC message identifiers
 */
function inferCategoryFromMessage(msgName: string): string {
  const upper = msgName.toUpperCase();
  if (upper.includes('STEERING') || upper.includes('SW_') || upper.includes('WHEEL')) {
    return 'Steering Wheel';
  }
  if (upper.includes('CLIMATE') || upper.includes('HVAC') || upper.includes('TEMP')) {
    return 'Cabin Climate Control';
  }
  if (upper.includes('SEAT')) {
    return 'Seats & Steering Wheel Comfort';
  }
  if (upper.includes('DOOR') || upper.includes('LOCK') || upper.includes('TAILGATE')) {
    return 'Vehicle Actuators & Features';
  }
  if (upper.includes('BATTERY') || upper.includes('BMS') || upper.includes('SOC')) {
    return 'Battery & Power';
  }
  if (upper.includes('CHARG') || upper.includes('EV_')) {
    return 'EV Charging Limits';
  }
  if (upper.includes('PRECON')) {
    return 'Battery Preconditioning';
  }
  if (upper.includes('CLUSTER') || upper.includes('POPUP') || upper.includes('OSD')) {
    return 'Cluster OSD Popups';
  }
  if (upper.includes('STATE') || upper.includes('GEAR') || upper.includes('SPEED')) {
    return 'Vehicle State & Safety';
  }

  // Convert snake/camel to clean Title Case
  return upper
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Sanitizes command ID to lowercase slug
 */
function sanitizeCommandId(sigName: string): string {
  return sigName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Humanizes a signal name into readable title
 * e.g. "SW_STAR_BTN" -> "Star Btn"
 */
function humanizeSignalName(sigName: string): string {
  return sigName
    .replace(/^SIG_/i, '')
    .replace(/^SW_/i, 'Steering ')
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
