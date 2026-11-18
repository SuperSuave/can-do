import { Command, Catalog, ValidationIssue, CatalogValidationReport, Vehicle } from '../types/catalog';
import {
  AutomationRule,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction
} from '../types/automation';

// Helper to validate single hex byte or wildcard
export function isValidPayloadToken(token: string): boolean {
  if (!token) return false;
  // full wildcard
  if (token === '*') return true;
  // range-value template placeholder (param_range steps)
  if (token.toLowerCase() === '{value}') return true;
  // nibble wildcard: *0, 0*, *A, F*
  if (/^(\*[0-9A-Fa-f]|[0-9A-Fa-f]\*)$/.test(token)) return true;
  // negated byte: !00, !12, !FF
  if (/^![0-9A-Fa-f]{2}$/.test(token)) return true;
  // exact hex byte
  if (/^[0-9A-Fa-f]{2}$/.test(token)) return true;
  return false;
}

// Validates a full space-separated payload string or raw hex string
export function validatePayloadString(payloadStr: string | undefined): { isValid: boolean; byteCount: number; error?: string } {
  if (!payloadStr || payloadStr.trim() === '') {
    return { isValid: true, byteCount: 0 };
  }

  const trimmed = payloadStr.trim();
  const cleanHex = trimmed.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!trimmed.includes(' ') && cleanHex.length >= 2 && cleanHex.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(cleanHex)) {
    return { isValid: true, byteCount: cleanHex.length / 2 };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 4096) {
    return {
      isValid: false,
      byteCount: tokens.length,
      error: `Payload exceeds maximum transport limit (${tokens.length} bytes detected)`
    };
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isValidPayloadToken(t)) {
      return {
        isValid: false,
        byteCount: tokens.length,
        error: `Invalid byte token '${t}' at position ${i + 1}. Must be hex (e.g. '0F'), wildcard ('*'), nibble wildcard ('0*', '*F'), or mask ('!12').`
      };
    }
  }

  return { isValid: true, byteCount: tokens.length };
}

// Validates either a space-separated string, raw hex string, or a D1..D8 ByteMap / hex object
export function validatePayload(payload: string | Record<string, string> | undefined): { isValid: boolean; byteCount: number; error?: string } {
  if (!payload) return { isValid: true, byteCount: 0 };
  if (typeof payload === 'object') {
    // 1. Check for hex payload format (e.g. { hex: "64000000FF00FF0100" })
    if ('hex' in payload || 'data' in payload || 'raw' in payload) {
      const hexVal = (payload.hex ?? payload.data ?? payload.raw) as string;
      if (typeof hexVal !== 'string') {
        return { isValid: false, byteCount: 0, error: `Invalid 'hex' payload value. Must be a string.` };
      }
      const clean = hexVal.replace(/\s+/g, '').replace(/^0x/i, '');
      if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(clean)) {
        return { isValid: false, byteCount: 0, error: `Invalid 'hex' payload value '${hexVal}'. Must be an even number of hex characters.` };
      }
      return { isValid: true, byteCount: clean.length / 2 };
    }

    // 2. Validate D1..D8 (or CAN-FD up to D64) ByteMap
    const keys = Object.keys(payload);
    for (const k of keys) {
      if (!/^D([1-9]|[1-5][0-9]|6[0-4])$/.test(k)) {
        return { isValid: false, byteCount: keys.length, error: `Invalid byte key '${k}'. Must be D1 through D8 (or 'hex').` };
      }
      const val = payload[k];
      const cleanVal = val.replace(/^!?(0x)?/i, '');
      if (cleanVal.length > 2 || (cleanVal.length > 0 && !/^[0-9A-Fa-f]{1,2}$/.test(cleanVal))) {
        return { isValid: false, byteCount: keys.length, error: `Invalid byte value '${val}' for '${k}'.` };
      }
    }
    return { isValid: true, byteCount: keys.length };
  }
  return validatePayloadString(payload);
}

// Validates CAN ID
export function validateCanId(canId: string | undefined): { isValid: boolean; isExtended?: boolean; error?: string } {
  if (!canId || canId.trim() === '') {
    return { isValid: true };
  }

  const trimmed = canId.trim();
  if (!/^0x[0-9A-Fa-f]{1,8}$/i.test(trimmed)) {
    return {
      isValid: false,
      error: `CAN ID must be in hexadecimal format starting with '0x' (e.g. 0x448, 0x652).`
    };
  }

  const numericVal = parseInt(trimmed, 16);
  if (isNaN(numericVal) || numericVal < 0) {
    return { isValid: false, error: 'Invalid CAN ID numeric value.' };
  }

  if (numericVal > 0x1fffffff) {
    return {
      isValid: false,
      error: `CAN ID exceeds maximum 29-bit extended address (0x1FFFFFFF).`
    };
  }

  return {
    isValid: true,
    isExtended: numericVal > 0x7ff
  };
}

// Collect all known features across all vehicles and commands
export function getAllKnownFeatures(catalog: Catalog): Set<string> {
  const features = new Set<string>();
  catalog.vehicles.forEach(v => {
    v.features?.forEach(f => features.add(f));
  });
  catalog.commands.forEach(c => {
    if (c.requires_feature) {
      features.add(c.requires_feature);
    }
    c.options?.forEach(opt => {
      if (opt.requires_feature) {
        features.add(opt.requires_feature);
      }
    });
  });
  return features;
}

// Validate single vehicle
export function validateVehicle(
  vehicle: Partial<Vehicle>,
  catalog?: Catalog,
  isNew: boolean = false,
  originalId?: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!vehicle.id || vehicle.id.trim() === '') {
    issues.push({ type: 'error', field: 'id', message: 'Vehicle unique ID is required.' });
  } else if (!/^[a-zA-Z0-9_-]+$/.test(vehicle.id)) {
    issues.push({
      type: 'error',
      field: 'id',
      message: 'Vehicle ID can only contain letters, numbers, underscores, and hyphens.'
    });
  }

  // Duplicate ID check
  if (catalog && vehicle.id) {
    const isDuplicate = catalog.vehicles.some(
      v => v.id === vehicle.id && (isNew || v.id !== originalId)
    );
    if (isDuplicate) {
      issues.push({
        type: 'error',
        field: 'id',
        message: `Vehicle ID '${vehicle.id}' already exists in the catalog.`
      });
    }
  }

  if (!vehicle.make || vehicle.make.trim() === '') {
    issues.push({ type: 'error', field: 'make', message: 'Vehicle make is required (e.g. Hyundai, Kia).' });
  }

  if (!vehicle.model || vehicle.model.trim() === '') {
    issues.push({ type: 'error', field: 'model', message: 'Vehicle model is required (e.g. Ioniq 5, EV6).' });
  }

  if (!vehicle.trim || vehicle.trim.trim() === '') {
    issues.push({ type: 'error', field: 'trim', message: 'Trim name is required (e.g. Limited, Wind, Base).' });
  }

  if (!vehicle.family || vehicle.family.trim() === '') {
    issues.push({ type: 'error', field: 'family', message: 'Platform family is required (e.g. ioniq5, ev6).' });
  }

  if (!vehicle.features || vehicle.features.length === 0) {
    issues.push({
      type: 'warning',
      field: 'features',
      message: 'Vehicle has no features enabled. Commands requiring trim features will not match.'
    });
  }

  return issues;
}

// Validate single command
export function validateCommand(
  command: Partial<Command>,
  catalog?: Catalog,
  isNew: boolean = false,
  originalId?: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ID validation
  if (!command.id || command.id.trim() === '') {
    issues.push({ type: 'error', field: 'id', message: 'Command ID is required.', commandId: command.id });
  } else if (!/^[a-z0-9_]+$/.test(command.id)) {
    issues.push({
      type: 'error',
      field: 'id',
      message: 'Command ID can only contain lowercase letters, numbers, and underscores (e.g. sw_star).',
      commandId: command.id
    });
  }

  // Check uniqueness if catalog provided
  if (catalog && command.id && (isNew || originalId !== undefined)) {
    const existing = catalog.commands.some(
      c => c.id === command.id && (isNew || c.id !== originalId)
    );
    if (existing) {
      issues.push({
        type: 'error',
        field: 'id',
        message: `Command ID '${command.id}' already exists in catalog.`,
        commandId: command.id
      });
    }
  }

  // Name validation
  const effectiveName = command.name || command.ha_metadata?.name;
  if (!effectiveName || effectiveName.trim() === '') {
    issues.push({ type: 'error', field: 'name', message: 'Command name is required.', commandId: command.id });
  }

  // Category validation
  if (!command.category || command.category.trim() === '') {
    issues.push({ type: 'error', field: 'category', message: 'Category is required.', commandId: command.id });
  }

  // Roles validation
  if (!command.roles || command.roles.length === 0) {
    issues.push({
      type: 'error',
      field: 'roles',
      message: 'At least one role (trigger, condition, action) must be assigned.',
      commandId: command.id
    });
  }

  // State CAN ID validation
  const effectiveStateCanId = command.network?.state_can_id || command.state_can_id;
  if (effectiveStateCanId) {
    const stateCanResult = validateCanId(effectiveStateCanId);
    if (!stateCanResult.isValid) {
      issues.push({
        type: 'error',
        field: 'state_can_id',
        message: `State CAN ID error: ${stateCanResult.error}`,
        commandId: command.id
      });
    } else if (stateCanResult.isExtended) {
      issues.push({
        type: 'info',
        field: 'state_can_id',
        message: `Extended 29-bit State CAN ID detected (${effectiveStateCanId}).`,
        commandId: command.id
      });
    }
  } else {
    // If it's a can_state, state_can_id is expected for tracking vehicle state
    const netType = command.network?.type || command.type;
    if (netType === 'can_state') {
      issues.push({
        type: 'warning',
        field: 'state_can_id',
        message: `Command type is 'can_state', but no State CAN ID is specified.`,
        commandId: command.id
      });
    }
  }

  // Action CAN ID validation (when actuation uses a separate CAN ID)
  const effectiveActionCanId = command.network?.action_can_id || command.action_can_id;
  if (effectiveActionCanId) {
    const actResult = validateCanId(effectiveActionCanId);
    if (!actResult.isValid) {
      issues.push({
        type: 'error',
        field: 'action_can_id',
        message: `Action CAN ID error: ${actResult.error}`,
        commandId: command.id
      });
    } else if (actResult.isExtended) {
      issues.push({
        type: 'info',
        field: 'action_can_id',
        message: `Extended 29-bit Action CAN ID detected (${effectiveActionCanId}).`,
        commandId: command.id
      });
    }
  }

  // Bus validation
  const effectiveBus = command.network?.bus ?? command.bus;
  if (effectiveBus !== undefined && (typeof effectiveBus !== 'number' || effectiveBus < 0)) {
    issues.push({
      type: 'error',
      field: 'bus',
      message: 'Bus must be a non-negative integer (e.g. 0 for primary CAN, 1 for secondary).',
      commandId: command.id
    });
  }

  if (command.action_bus !== undefined && (typeof command.action_bus !== 'number' || command.action_bus < 0)) {
    issues.push({
      type: 'error',
      field: 'action_bus',
      message: 'Action Bus must be a non-negative integer.',
      commandId: command.id
    });
  }

  // Payload validations
  if (command.from_payload !== undefined) {
    const res = validatePayload(command.from_payload);
    if (!res.isValid) {
      issues.push({ type: 'error', field: 'from_payload', message: res.error!, commandId: command.id });
    }
  }

  if (command.to_payload !== undefined) {
    const res = validatePayload(command.to_payload);
    if (!res.isValid) {
      issues.push({ type: 'error', field: 'to_payload', message: res.error!, commandId: command.id });
    }
  }

  const matchTarget = command.match ?? command.match_payload;
  if (matchTarget !== undefined) {
    const res = validatePayload(matchTarget);
    if (!res.isValid) {
      issues.push({ type: 'error', field: 'match', message: res.error!, commandId: command.id });
    }
  }

  if (command.steps && command.steps.length > 0) {
    command.steps.forEach((st, sIdx) => {
      if (st.payload) {
        const stRes = validatePayload(st.payload);
        if (!stRes.isValid) {
          issues.push({
            type: 'error',
            field: `steps[${sIdx}]`,
            message: `Step #${sIdx + 1} error: ${stRes.error}`,
            commandId: command.id
          });
        }
      }
    });
  }

  // Options validation
  if (command.options && command.options.length > 0) {
    command.options.forEach((opt, idx) => {
      if (!opt.label || opt.label.trim() === '') {
        issues.push({
          type: 'error',
          field: `options[${idx}].label`,
          message: `Option #${idx + 1} is missing a label.`,
          commandId: command.id
        });
      }
      if (opt.payload) {
        const optRes = validatePayload(opt.payload);
        if (!optRes.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].payload`,
            message: `Option #${idx + 1} payload error: ${optRes.error}`,
            commandId: command.id
          });
        }
      }
      if (opt.from_payload) {
        const optRes = validatePayload(opt.from_payload);
        if (!optRes.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].from_payload`,
            message: `Option #${idx + 1} from_payload error: ${optRes.error}`,
            commandId: command.id
          });
        }
      }
      if (opt.to_payload) {
        const optRes = validatePayload(opt.to_payload);
        if (!optRes.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].to_payload`,
            message: `Option #${idx + 1} to_payload error: ${optRes.error}`,
            commandId: command.id
          });
        }
      }
      const optMatch = opt.match ?? opt.match_payload;
      if (optMatch) {
        const optRes = validatePayload(optMatch);
        if (!optRes.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].match`,
            message: `Option #${idx + 1} match error: ${optRes.error}`,
            commandId: command.id
          });
        }
      }
      if (opt.steps && opt.steps.length > 0) {
        opt.steps.forEach((st, sIdx) => {
          if (st.payload) {
            const stRes = validatePayload(st.payload);
            if (!stRes.isValid) {
              issues.push({
                type: 'error',
                field: `options[${idx}].steps[${sIdx}]`,
                message: `Option #${idx + 1} step #${sIdx + 1} error: ${stRes.error}`,
                commandId: command.id
              });
            }
          }
        });
      }
      if (opt.state_can_id) {
        const optCan = validateCanId(opt.state_can_id);
        if (!optCan.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].state_can_id`,
            message: `Option #${idx + 1} State CAN ID error: ${optCan.error}`,
            commandId: command.id
          });
        }
      }
      if (opt.action_can_id) {
        const optActCan = validateCanId(opt.action_can_id);
        if (!optActCan.isValid) {
          issues.push({
            type: 'error',
            field: `options[${idx}].action_can_id`,
            message: `Option #${idx + 1} Action CAN ID error: ${optActCan.error}`,
            commandId: command.id
          });
        }
      }
      if (opt.steps && opt.steps.length > 0) {
        opt.steps.forEach((step, sIdx) => {
          const isDelay = step.type === 'delay';
          if (isDelay) {
            const delayTime = step.delay_ms ?? step.dwell_ms ?? step.ms;
            if (delayTime === undefined || delayTime <= 0) {
              issues.push({
                type: 'warning',
                field: `options[${idx}].steps[${sIdx}].delay_ms`,
                message: `Option #${idx + 1} Delay Step #${sIdx + 1} has 0 or undefined duration.`,
                commandId: command.id
              });
            }
          } else if (!step.payload) {
            issues.push({
              type: 'error',
              field: `options[${idx}].steps[${sIdx}].payload`,
              message: `Option #${idx + 1} Step #${sIdx + 1} missing payload.`,
              commandId: command.id
            });
          } else {
            const stepRes = validatePayload(step.payload);
            if (!stepRes.isValid) {
              issues.push({
                type: 'error',
                field: `options[${idx}].steps[${sIdx}].payload`,
                message: `Option #${idx + 1} Step #${sIdx + 1} payload error: ${stepRes.error}`,
                commandId: command.id
              });
            }
          }
          const stepCanId = (step as any).can_id ?? (step as any).action_can_id;
          if (stepCanId) {
            const stepCanRes = validateCanId(stepCanId);
            if (!stepCanRes.isValid) {
              issues.push({
                type: 'error',
                field: `options[${idx}].steps[${sIdx}].can_id`,
                message: `Option #${idx + 1} Step #${sIdx + 1} CAN ID error: ${stepCanRes.error}`,
                commandId: command.id
              });
            }
          }
        });
      }
    });
  }

  // Steps validation
  if (command.steps && command.steps.length > 0) {
    command.steps.forEach((step, idx) => {
      const isDelay = step.type === 'delay';
      if (isDelay) {
        const delayTime = step.delay_ms ?? step.dwell_ms ?? step.ms;
        if (delayTime === undefined || delayTime <= 0) {
          issues.push({
            type: 'warning',
            field: `steps[${idx}].delay_ms`,
            message: `Delay Step #${idx + 1} has 0 or undefined duration.`,
            commandId: command.id
          });
        }
      } else if (!step.payload || (typeof step.payload === 'string' && step.payload.trim() === '')) {
        issues.push({
          type: 'error',
          field: `steps[${idx}].payload`,
          message: `Step #${idx + 1} is missing payload hex string.`,
          commandId: command.id
        });
      } else {
        const stepRes = validatePayload(step.payload);
        if (!stepRes.isValid) {
          issues.push({
            type: 'error',
            field: `steps[${idx}].payload`,
            message: `Step #${idx + 1} payload error: ${stepRes.error}`,
            commandId: command.id
          });
        }
      }
      const stepCanId = (step as any).can_id ?? (step as any).action_can_id;
      if (stepCanId) {
        const stepCanRes = validateCanId(stepCanId);
        if (!stepCanRes.isValid) {
          issues.push({
            type: 'error',
            field: `steps[${idx}].can_id`,
            message: `Step #${idx + 1} CAN ID error: ${stepCanRes.error}`,
            commandId: command.id
          });
        }
      }
      if (step.repeat !== undefined && step.repeat < 1) {
        issues.push({
          type: 'warning',
          field: `steps[${idx}].repeat`,
          message: `Step #${idx + 1} repeat count should be at least 1.`,
          commandId: command.id
        });
      }
    });
  }

  // Feature validation
  if (command.requires_feature && catalog) {
    const knownFeatures = getAllKnownFeatures(catalog);
    if (!knownFeatures.has(command.requires_feature)) {
      issues.push({
        type: 'warning',
        field: 'requires_feature',
        message: `Required feature '${command.requires_feature}' is not recognized in any existing vehicle in the catalog.`,
        commandId: command.id
      });
    }
  }

  if (command.options && catalog) {
    const knownFeatures = getAllKnownFeatures(catalog);
    command.options.forEach((opt, idx) => {
      if (opt.requires_feature && !knownFeatures.has(opt.requires_feature)) {
        issues.push({
          type: 'warning',
          field: `options[${idx}].requires_feature`,
          message: `Option #${idx + 1} required feature '${opt.requires_feature}' is not recognized in any existing vehicle in the catalog.`,
          commandId: command.id
        });
      }
    });
  }

  // Home Assistant ha_domain & icon/mdi validation
  if (command.ha_domain) {
    if (/[A-Z\s]/.test(command.ha_domain)) {
      issues.push({
        type: 'warning',
        field: 'ha_domain',
        message: `Home Assistant domain '${command.ha_domain}' should be lowercase without spaces (e.g. 'event', 'sensor', 'binary_sensor').`,
        commandId: command.id
      });
    }
  }

  const iconVal = command.icon || command.mdi;
  if (iconVal && !iconVal.startsWith('mdi:')) {
    issues.push({
      type: 'info',
      field: 'icon',
      message: `Home Assistant icon '${iconVal}' will be formatted with 'mdi:' prefix (e.g. 'mdi:${iconVal}').`,
      commandId: command.id
    });
  }

  return issues;
}

// Validate entire catalog
export function validateCatalog(catalog: Catalog): CatalogValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const infos: ValidationIssue[] = [];

  const seenIds = new Set<string>();
  const canIdGroups: Record<string, string[]> = {};
  const categoryCounts: Record<string, number> = {};
  const roleCounts: Record<Command['roles'][number], number> = {
    trigger: 0,
    condition: 0,
    action: 0
  };

  if (!catalog.can_do_version) {
    errors.push({ type: 'error', field: 'can_do_version', message: 'Missing can_do_version.' });
  }

  if (!Array.isArray(catalog.vehicles) || catalog.vehicles.length === 0) {
    warnings.push({ type: 'warning', field: 'vehicles', message: 'Catalog has no vehicles defined.' });
  }

  if (!Array.isArray(catalog.commands)) {
    errors.push({ type: 'error', field: 'commands', message: 'Catalog commands must be an array.' });
    return {
      isValid: false,
      errors,
      warnings,
      infos,
      totalCommands: 0,
      canIdGroups: {},
      categoryCounts: {},
      roleCounts
    };
  }

  catalog.commands.forEach((cmd, idx) => {
    // Duplicate ID check
    if (cmd.id) {
      if (seenIds.has(cmd.id)) {
        errors.push({
          type: 'error',
          field: 'id',
          message: `Duplicate command ID '${cmd.id}' detected at index ${idx}.`,
          commandId: cmd.id
        });
      }
      seenIds.add(cmd.id);
    }

    // Role counts
    cmd.roles?.forEach(role => {
      if (roleCounts[role] !== undefined) {
        roleCounts[role]++;
      }
    });

    // Category counts
    if (cmd.category) {
      categoryCounts[cmd.category] = (categoryCounts[cmd.category] || 0) + 1;
    }

    // CAN ID group tracking (bus + state_can_id)
    if (cmd.state_can_id) {
      const key = `${cmd.state_can_id} (Bus ${cmd.bus ?? 0})`;
      if (!canIdGroups[key]) {
        canIdGroups[key] = [];
      }
      canIdGroups[key].push(cmd.name || cmd.id);
    }
    if (cmd.action_can_id) {
      const actKey = `${cmd.action_can_id} (Bus ${cmd.action_bus ?? cmd.bus ?? 0}) [Tx]`;
      if (!canIdGroups[actKey]) {
        canIdGroups[actKey] = [];
      }
      canIdGroups[actKey].push(cmd.name || cmd.id);
    }

    // Validate single command
    const cmdIssues = validateCommand(cmd, catalog, false);
    cmdIssues.forEach(issue => {
      if (issue.type === 'error') errors.push(issue);
      else if (issue.type === 'warning') warnings.push(issue);
      else infos.push(issue);
    });
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    infos,
    totalCommands: catalog.commands.length,
    canIdGroups,
    categoryCounts,
    roleCounts
  };
}

// ============================================================================
// Pre-Push Automation Validation
// ============================================================================

export interface AutomationValidationIssue {
  type: 'error' | 'warning';
  ruleId: string;
  ruleName: string;
  section: 'general' | 'trigger' | 'condition' | 'action';
  itemIndex?: number;
  field?: string;
  message: string;
}

export interface AutomationValidationReport {
  isValid: boolean;
  hasWarnings: boolean;
  errors: AutomationValidationIssue[];
  warnings: AutomationValidationIssue[];
  issuesByRuleId: Record<string, AutomationValidationIssue[]>;
}

const VALID_1_BASED_BYTE_KEY_RE = /^D[1-8]$/i;

function isValidByteKey(key: string): boolean {
  return VALID_1_BASED_BYTE_KEY_RE.test(key.trim());
}

function checkEdgeHexOrNumeric(val: unknown): { isValid: boolean; error?: string } {
  if (val === undefined || val === null) return { isValid: true };
  if (typeof val === 'number') {
    return Number.isFinite(val)
      ? { isValid: true }
      : { isValid: false, error: 'Numeric byte value is not finite.' };
  }
  const s = String(val).trim();
  if (!s) return { isValid: true };
  if (/[*?]/.test(s)) {
    return {
      isValid: false,
      error: `Wildcard '${s}' is not supported on the ESP32 engine; use an exact hex byte and bitmask.`
    };
  }
  if (/^0x[0-9A-Fa-f]{1,2}$/i.test(s) || /^[0-9A-Fa-f]{1,2}$/.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    return { isValid: true };
  }
  return {
    isValid: false,
    error: `Invalid byte/value '${s}'. Expected hex byte (e.g. '0x10') or decimal number.`
  };
}

function checkEdgePayload(
  payload: string | Record<string, string> | undefined,
  allowWildcards: boolean
): { isValid: boolean; isEmpty: boolean; error?: string } {
  if (!payload) return { isValid: true, isEmpty: true };

  if (typeof payload === 'object') {
    if ('hex' in payload || 'data' in payload || 'raw' in payload) {
      const hexVal = (payload.hex ?? payload.data ?? payload.raw) as string;
      const res = validatePayload({ hex: hexVal });
      return { isValid: res.isValid, isEmpty: res.byteCount === 0, error: res.error };
    }
    const keys = Object.keys(payload);
    if (keys.length === 0) return { isValid: true, isEmpty: true };
    for (const k of keys) {
      if (!isValidByteKey(k)) {
        return {
          isValid: false,
          isEmpty: false,
          error: `Invalid byte key '${k}'. Byte positions must use 1-based indexing (D1–D8).`
        };
      }
      const v = String(payload[k] ?? '').trim();
      if (!allowWildcards && /[*?]/.test(v)) {
        return {
          isValid: false,
          isEmpty: false,
          error: `Wildcard '${v}' in ${k} is not allowed on the ESP32 engine.`
        };
      }
      if (!allowWildcards) {
        const hexCheck = checkEdgeHexOrNumeric(v);
        if (!hexCheck.isValid) {
          return { isValid: false, isEmpty: false, error: `${k}: ${hexCheck.error}` };
        }
      } else {
        const res = validatePayload({ [k]: v });
        if (!res.isValid) {
          return { isValid: false, isEmpty: false, error: res.error };
        }
      }
    }
    return { isValid: true, isEmpty: false };
  }

  const trimmed = String(payload).trim();
  if (!trimmed) return { isValid: true, isEmpty: true };

  if (!allowWildcards && /[*?]/.test(trimmed)) {
    return {
      isValid: false,
      isEmpty: false,
      error: `Wildcards ('*'/'?') are not supported in ESP32 transmit or edge payloads ('${trimmed}').`
    };
  }
  const strRes = validatePayloadString(trimmed);
  return { isValid: strRes.isValid, isEmpty: strRes.byteCount === 0, error: strRes.error };
}

function findCatalogCommand(id: string | undefined, catalog?: Catalog): Command | undefined {
  if (!id || !catalog?.commands) return undefined;
  return catalog.commands.find(c => c.id === id || c.entity_id === id);
}

function validateTriggerNode(
  trig: AutomationTrigger,
  idx: number,
  ruleMeta: { id: string; name: string },
  rule: AutomationRule,
  catalog: Catalog | undefined,
  issues: AutomationValidationIssue[]
) {
  const push = (type: 'error' | 'warning', field: string | undefined, message: string) => {
    issues.push({
      type,
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'trigger',
      itemIndex: idx,
      field,
      message: `Trigger #${idx + 1}: ${message}`
    });
  };

  const tType = trig.type || '';
  const tSource = trig.source || '';

  if (tType === 'time_schedule' || tSource === 'time') {
    if (trig.time) {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(trig.time.trim())) {
        push('error', 'time', `Invalid time format '${trig.time}'. Expected HH:MM (24-hour).`);
      }
    } else if (!trig.interval_sec || trig.interval_sec <= 0) {
      push('error', 'time', 'Time schedule trigger requires a valid HH:MM time or positive interval.');
    }
    return;
  }

  if (tType === 'ble_button' || tType === 'ble_key' || (tSource === 'ble' && trig.ble_button !== undefined)) {
    if (!trig.ble_button?.trim() && !trig.source_command_id) {
      push('error', 'ble_button', 'Bluetooth button trigger has no button selected.');
    }
    return;
  }

  if (
    tType === 'ble_presence' ||
    tType === 'ble_beacon' ||
    tType === 'beacon' ||
    tSource === 'ble' ||
    tType === 'wifi' ||
    tType === 'wifi_event' ||
    tType === 'device_event' ||
    tSource === 'wifi'
  ) {
    return;
  }

  if (tSource === 'voltage' || tType === 'voltage') {
    const val = parseFloat(String(trig.voltage_val ?? trig.value ?? ''));
    if (isNaN(val) || val <= 0 || val > 100) {
      push('error', 'voltage_val', 'Voltage trigger requires a valid voltage threshold (0–100 V).');
    }
    return;
  }

  if (tSource === 'mqtt' || tType === 'mqtt') {
    if (!trig.mqtt_topic?.trim()) {
      push('error', 'mqtt_topic', 'MQTT trigger is missing a topic filter.');
    }
    return;
  }

  // CAN Trigger (can_rx, byte_transition, preset, default CAN)
  const catalogCmd = findCatalogCommand(trig.source_command_id || trig.target_entity_id, catalog);
  const canId = trig.can_id || catalogCmd?.state_can_id;

  if (!canId || !canId.trim()) {
    push('error', 'can_id', 'CAN trigger is missing a CAN ID.');
  } else {
    const idCheck = validateCanId(canId);
    if (!idCheck.isValid) {
      push('error', 'can_id', idCheck.error || `Invalid CAN ID '${canId}'.`);
    } else if (canId.trim().toLowerCase() === '0x000') {
      push('warning', 'can_id', 'CAN ID is set to placeholder 0x000.');
    }
  }

  const byteKey = trig.byte || trig.evaluate?.byte;
  if (byteKey && !isValidByteKey(byteKey)) {
    push('error', 'byte', `Invalid byte position '${byteKey}' (must use 1-based indexing D1–D8).`);
  }
  if (trig.byte_index !== undefined && (!Number.isInteger(trig.byte_index) || trig.byte_index < 0 || trig.byte_index > 7)) {
    push('error', 'byte_index', `Byte index ${trig.byte_index} is out of bounds (expected 0–7 internal offset).`);
  }

  for (const [field, val] of [
    ['from', trig.from],
    ['to', trig.to],
    ['value', trig.value ?? trig.evaluate?.value],
    ['mask', typeof trig.mask === 'string' ? trig.mask : trig.evaluate?.mask]
  ] as const) {
    if (typeof val === 'string' && val.trim() !== '') {
      const check = checkEdgeHexOrNumeric(val);
      if (!check.isValid) {
        push('error', field, check.error || `Invalid ${field} value.`);
      }
    }
  }

  for (const [field, mapVal] of [
    ['from_payload', trig.from_payload],
    ['to_payload', trig.to_payload],
    ['match_payload', trig.match_payload],
    ['match', trig.match]
  ] as const) {
    if (mapVal) {
      const pCheck = checkEdgePayload(mapVal as any, false);
      if (!pCheck.isValid) {
        push('error', field, pCheck.error || `Invalid ${field}.`);
      }
    }
  }

  // Warn on rapid periodic CAN RX triggers with no cooldown/sustained/transition check
  const isRawCanRx = tType === 'can_rx';
  const hasSustained = Boolean(trig.for_ms || trig.for_sec || (trig.click_count && trig.click_count > 1));
  const hasTransition = trig.from !== undefined && trig.from !== '';
  if (isRawCanRx && !hasSustained && !hasTransition && (rule.cooldown_ms ?? 0) < 250) {
    push(
      'warning',
      'cooldown_ms',
      'Periodic CAN RX trigger has no sustained duration or >= 250ms cooldown and may re-fire rapidly.'
    );
  }
}

function validateConditionNode(
  cond: AutomationCondition,
  idx: number,
  ruleMeta: { id: string; name: string },
  catalog: Catalog | undefined,
  issues: AutomationValidationIssue[],
  pathPrefix = ''
) {
  const prefix = pathPrefix ? `${pathPrefix}Condition #${idx + 1}` : `Condition #${idx + 1}`;
  const push = (type: 'error' | 'warning', field: string | undefined, message: string) => {
    issues.push({
      type,
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'condition',
      itemIndex: pathPrefix ? undefined : idx,
      field,
      message: `${prefix}: ${message}`
    });
  };

  // Logic groups (AND / OR / NOT)
  const isLogicGroup =
    cond.logic === 'and' ||
    cond.logic === 'or' ||
    cond.logic === 'not' ||
    cond.type === 'and' ||
    cond.type === 'or' ||
    cond.type === 'not' ||
    cond.type === 'and_group' ||
    cond.type === 'or_group' ||
    cond.type === 'not_group';

  if (isLogicGroup) {
    const children: AutomationCondition[] =
      cond.conditions ||
      cond.and ||
      cond.or ||
      (Array.isArray(cond.not) ? cond.not : cond.not ? [cond.not] : []);
    if (children.length === 0) {
      push('warning', 'conditions', 'Logic group has no child conditions.');
    } else {
      children.forEach((child, cIdx) => {
        validateConditionNode(child, cIdx, ruleMeta, catalog, issues, `${prefix} ▸ `);
      });
    }
    return;
  }

  const cType = cond.type || '';
  if (cType === 'triggered_by' || cType === 'trigger') {
    if (!cond.trigger_id?.trim()) {
      push('warning', 'trigger_id', 'Triggered-by condition has no trigger selected.');
    }
    return;
  }

  if (cType === 'time_condition' || cType === 'time') {
    if (cond.start_time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(cond.start_time.trim())) {
      push('error', 'start_time', `Invalid start time '${cond.start_time}'. Expected HH:MM.`);
    }
    if (cond.end_time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(cond.end_time.trim())) {
      push('error', 'end_time', `Invalid end time '${cond.end_time}'. Expected HH:MM.`);
    }
    return;
  }

  if (cType === 'voltage') {
    const val = parseFloat(String(cond.value ?? cond.voltage_val ?? ''));
    if (isNaN(val) || val <= 0 || val > 100) {
      push('error', 'voltage_val', 'Voltage condition requires a valid voltage threshold (0–100 V).');
    }
    return;
  }

  if (
    cType === 'device_state' ||
    cType === 'wifi' ||
    cType === 'wifi_condition' ||
    cType === 'ble_button' ||
    cType === 'ble_key' ||
    cType === 'ble_device' ||
    cType === 'ble_beacon' ||
    cType === 'beacon' ||
    cType === 'ble_presence' ||
    cType === 'ble'
  ) {
    return;
  }

  // CAN condition
  const catalogCmd = findCatalogCommand(cond.source_command_id, catalog);
  const canId = cond.can_id || catalogCmd?.state_can_id;

  if (!canId || !canId.trim()) {
    push('error', 'can_id', 'CAN condition is missing a CAN ID.');
  } else {
    const idCheck = validateCanId(canId);
    if (!idCheck.isValid) {
      push('error', 'can_id', idCheck.error || `Invalid CAN ID '${canId}'.`);
    } else if (canId.trim().toLowerCase() === '0x000') {
      push('warning', 'can_id', 'CAN ID is set to placeholder 0x000.');
    }
  }

  const byteKey = cond.byte || cond.evaluate?.byte;
  if (byteKey && !isValidByteKey(byteKey)) {
    push('error', 'byte', `Invalid byte position '${byteKey}' (must use 1-based indexing D1–D8).`);
  }
  if (cond.byte_index !== undefined && (!Number.isInteger(cond.byte_index) || cond.byte_index < 0 || cond.byte_index > 7)) {
    push('error', 'byte_index', `Byte index ${cond.byte_index} is out of bounds (expected 0–7 internal offset).`);
  }

  const targetVal = cond.value ?? cond.evaluate?.value;
  if (typeof targetVal === 'string' && targetVal.trim() !== '') {
    const check = checkEdgeHexOrNumeric(targetVal);
    if (!check.isValid) {
      push('error', 'value', check.error || 'Invalid condition target value.');
    }
  }

  const maskVal = cond.mask ?? cond.evaluate?.mask;
  if (typeof maskVal === 'string' && maskVal.trim() !== '') {
    const check = checkEdgeHexOrNumeric(maskVal);
    if (!check.isValid) {
      push('error', 'mask', check.error || 'Invalid bitmask value.');
    }
  } else if (maskVal && typeof maskVal === 'object') {
    const pCheck = checkEdgePayload(maskVal as Record<string, string>, false);
    if (!pCheck.isValid) {
      push('error', 'mask', pCheck.error || 'Invalid bitmask ByteMap.');
    }
  }

  for (const [field, mapVal] of [
    ['match', cond.match],
    ['match_payload', cond.match_payload]
  ] as const) {
    if (mapVal) {
      const pCheck = checkEdgePayload(mapVal as any, false);
      if (!pCheck.isValid) {
        push('error', field, pCheck.error || `Invalid ${field}.`);
      }
    }
  }
}

function validateActionNode(
  act: AutomationAction,
  idx: number,
  ruleMeta: { id: string; name: string },
  catalog: Catalog | undefined,
  issues: AutomationValidationIssue[],
  pathPrefix = ''
) {
  const prefix = pathPrefix ? `${pathPrefix}Action #${idx + 1}` : `Action #${idx + 1}`;
  const push = (type: 'error' | 'warning', field: string | undefined, message: string) => {
    issues.push({
      type,
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'action',
      itemIndex: pathPrefix ? undefined : idx,
      field,
      message: `${prefix}: ${message}`
    });
  };

  const aType = act.type;

  if (aType === 'if_then') {
    if (!act.conditions || act.conditions.length === 0) {
      push('warning', 'conditions', 'If / Then block has no conditions (Then branch will always run).');
    } else {
      act.conditions.forEach((c, cIdx) =>
        validateConditionNode(c, cIdx, ruleMeta, catalog, issues, `${prefix} (If) ▸ `)
      );
    }

    const thenList = act.then || [];
    const elseList = act.else || [];
    if (thenList.length === 0 && elseList.length === 0) {
      push('error', 'then', 'If / Then block has no actions in either Then or Else.');
    } else {
      thenList.forEach((sub, sIdx) =>
        validateActionNode(sub, sIdx, ruleMeta, catalog, issues, `${prefix} (Then) ▸ `)
      );
      elseList.forEach((sub, sIdx) =>
        validateActionNode(sub, sIdx, ruleMeta, catalog, issues, `${prefix} (Else) ▸ `)
      );
    }
    return;
  }

  if (aType === 'choose') {
    const choices = act.choices || [];
    const def = act.default || [];
    if (choices.length === 0 && def.length === 0) {
      push('error', 'choices', 'Choose block has no conditional branches or default actions.');
      return;
    }

    choices.forEach((branch, bIdx) => {
      const bLabel = branch.label?.trim() ? `Branch "${branch.label}"` : `Branch #${bIdx + 1}`;
      if (!branch.conditions || branch.conditions.length === 0) {
        push('warning', `choices[${bIdx}].conditions`, `${bLabel} has no conditions and will always match first.`);
      } else {
        branch.conditions.forEach((c, cIdx) =>
          validateConditionNode(c, cIdx, ruleMeta, catalog, issues, `${prefix} (${bLabel}) ▸ `)
        );
      }

      if (!branch.sequence || branch.sequence.length === 0) {
        push('error', `choices[${bIdx}].sequence`, `${bLabel} has no actions.`);
      } else {
        branch.sequence.forEach((sub, sIdx) =>
          validateActionNode(sub, sIdx, ruleMeta, catalog, issues, `${prefix} (${bLabel}) ▸ `)
        );
      }
    });

    def.forEach((sub, sIdx) =>
      validateActionNode(sub, sIdx, ruleMeta, catalog, issues, `${prefix} (Default) ▸ `)
    );
    return;
  }

  if (aType === 'wait_for' || aType === 'repeat_until') {
    const label = aType === 'wait_for' ? 'Wait For' : 'Repeat Until';
    const conds = act.conditions && act.conditions.length > 0 ? act.conditions : (act.condition ? [act.condition] : []);
    if (conds.length === 0) {
      push('error', 'condition', `${label} requires at least one stop condition.`);
    } else {
      conds.forEach((c, cIdx) =>
        validateConditionNode(c, cIdx, ruleMeta, catalog, issues, `${prefix} (${label}) ▸ `)
      );
    }

    if (act.timeout_ms !== undefined && (isNaN(Number(act.timeout_ms)) || Number(act.timeout_ms) <= 0)) {
      push('error', 'timeout_ms', `${label} timeout must be greater than 0 ms.`);
    }
    if (act.interval_ms !== undefined && (isNaN(Number(act.interval_ms)) || Number(act.interval_ms) <= 0)) {
      push('error', 'interval_ms', `${label} check interval must be greater than 0 ms.`);
    }

    if (aType === 'repeat_until') {
      if (!act.sequence || act.sequence.length === 0) {
        push('error', 'sequence', 'Repeat Until block has no actions in its loop sequence.');
      } else {
        act.sequence.forEach((sub, sIdx) =>
          validateActionNode(sub, sIdx, ruleMeta, catalog, issues, `${prefix} (Loop) ▸ `)
        );
      }
    }
    return;
  }

  if (aType === 'cycle_entity') {
    const entId = (act.entity_id || act.target_command_id || '').trim();
    if (!entId) {
      push('error', 'entity_id', 'Cycle Entity action is missing a target entity.');
    } else if (catalog?.commands && catalog.commands.length > 0 && !findCatalogCommand(entId, catalog)) {
      push('warning', 'entity_id', `Entity '${entId}' was not found in the active catalog.`);
    }

    if (!Array.isArray(act.states) || act.states.length === 0) {
      push('error', 'states', `Cycle Entity action${entId ? ` for '${entId}'` : ''} has 0 states selected.`);
    } else if (act.states.length === 1) {
      push('warning', 'states', `Cycle Entity action for '${entId || 'entity'}' only has 1 state; add 2+ states to cycle.`);
    }
    return;
  }

  if (aType === 'delay') {
    const ms = act.delay_ms ?? act.ms;
    if (ms === undefined || isNaN(Number(ms)) || Number(ms) <= 0) {
      push('error', 'delay_ms', 'Delay action must have a positive duration in milliseconds.');
    }
    return;
  }

  if (aType === 'track_popup' || aType === 'popup') {
    if (!(act.text || act.popup_message)?.trim()) {
      push('error', 'text', 'Head unit popup action has empty message text.');
    }
    return;
  }

  if (aType === 'hud_nav' || aType === 'nav') {
    const navMode = act.nav_action || act.action || 'update';
    if (navMode !== 'clear') {
      const lanes = act.num_lanes ?? act.lanes ?? 0;
      if (lanes < 0 || lanes > 8) {
        push('error', 'num_lanes', 'HUD Navigation lane count must be between 0 and 8.');
      }
    }
    return;
  }

  if (aType === 'climate_target' || aType === 'remote_climate') {
    const temp = act.target_temp_c ?? act.target_c;
    if (temp !== undefined && (isNaN(Number(temp)) || Number(temp) < 10 || Number(temp) > 35)) {
      push('warning', 'target_temp_c', `Climate target temperature ${temp}°C is outside normal E-GMP range (14–30°C).`);
    }
    return;
  }

  if (aType === 'precondition') {
    return;
  }

  if (aType === 'webhook') {
    push('warning', 'type', 'Webhook actions cannot run offline on the ESP32; consider CAN TX or Home Assistant MQTT.');
    return;
  }

  // Default: can_tx / transmit / entity_command
  const catalogCmd = findCatalogCommand(
    act.entity_id || act.source_command_id || act.target_command_id,
    catalog
  );

  if (act.steps && act.steps.length > 0) {
    act.steps.forEach((step, sIdx) => {
      if (step.type === 'delay') {
        const ms = step.delay_ms ?? step.ms;
        if (ms !== undefined && (isNaN(Number(ms)) || Number(ms) <= 0)) {
          push('error', `steps[${sIdx}]`, `Step #${sIdx + 1} delay must be > 0 ms.`);
        }
        return;
      }
      const stepCanId = step.can_id || step.action_can_id || act.can_id || catalogCmd?.action_can_id || catalogCmd?.state_can_id;
      if (!stepCanId || !stepCanId.trim()) {
        push('error', `steps[${sIdx}].can_id`, `Step #${sIdx + 1} is missing a CAN ID.`);
      } else {
        const idCheck = validateCanId(stepCanId);
        if (!idCheck.isValid) {
          push('error', `steps[${sIdx}].can_id`, `Step #${sIdx + 1}: ${idCheck.error}`);
        }
      }

      const pCheck = checkEdgePayload(step.payload as any, false);
      if (!pCheck.isValid) {
        push('error', `steps[${sIdx}].payload`, `Step #${sIdx + 1}: ${pCheck.error}`);
      } else if (pCheck.isEmpty) {
        push('error', `steps[${sIdx}].payload`, `Step #${sIdx + 1} has an empty CAN payload.`);
      }
    });
    return;
  }

  if (aType === 'entity_command' && (act.target_command_id || act.entity_id) && catalogCmd) {
    return;
  }

  const canId = act.can_id || catalogCmd?.action_can_id || catalogCmd?.state_can_id;
  if (!canId || !canId.trim()) {
    push('error', 'can_id', 'CAN Transmit action is missing a target CAN ID.');
  } else {
    const idCheck = validateCanId(canId);
    if (!idCheck.isValid) {
      push('error', 'can_id', idCheck.error || `Invalid CAN ID '${canId}'.`);
    } else if (canId.trim().toLowerCase() === '0x000') {
      push('warning', 'can_id', 'CAN ID is set to placeholder 0x000.');
    }
  }

  const effectivePayload = act.payload ?? act.to_payload;
  const pCheck = checkEdgePayload(effectivePayload as any, false);
  if (!pCheck.isValid) {
    push('error', 'payload', pCheck.error || 'Invalid CAN TX payload.');
  } else if (pCheck.isEmpty && !act.option_label && !act.command) {
    push('error', 'payload', 'CAN Transmit action has an empty payload.');
  }
}

export function validateAutomationRule(
  rule: AutomationRule,
  catalog?: Catalog,
  isDuplicateId: boolean = false
): AutomationValidationIssue[] {
  const issues: AutomationValidationIssue[] = [];
  const ruleMeta = {
    id: rule.id || '(missing-id)',
    name: rule.name?.trim() || rule.id || 'Unnamed Rule'
  };

  if (!rule.id || !rule.id.trim()) {
    issues.push({
      type: 'error',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'general',
      field: 'id',
      message: 'Rule is missing a unique ID.'
    });
  } else if (isDuplicateId) {
    issues.push({
      type: 'error',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'general',
      field: 'id',
      message: `Duplicate rule ID '${rule.id}' conflicts with another rule.`
    });
  }

  if (!rule.name || !rule.name.trim()) {
    issues.push({
      type: 'warning',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'general',
      field: 'name',
      message: 'Rule has an empty name.'
    });
  }

  const triggers = rule.triggers || [];
  const conditions = rule.conditions || [];
  const actions = rule.actions || [];

  if (rule.enabled && triggers.length === 0) {
    issues.push({
      type: 'warning',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'trigger',
      message: 'Enabled rule has no triggers (will only run manually or from Home Assistant).'
    });
  }

  if ((rule.trigger_mode === 'all' || rule.trigger_mode === 'sequence') && triggers.length < 2) {
    issues.push({
      type: 'warning',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'general',
      field: 'trigger_mode',
      message: `Trigger Mode is '${rule.trigger_mode === 'all' ? 'All Triggers (AND)' : 'Sequence'}', which requires 2 or more triggers.`
    });
  }

  if (actions.length === 0) {
    issues.push({
      type: 'error',
      ruleId: ruleMeta.id,
      ruleName: ruleMeta.name,
      section: 'action',
      message: 'Rule has no actions configured.'
    });
  }

  triggers.forEach((trig, idx) => validateTriggerNode(trig, idx, ruleMeta, rule, catalog, issues));
  conditions.forEach((cond, idx) => validateConditionNode(cond, idx, ruleMeta, catalog, issues));
  actions.forEach((act, idx) => validateActionNode(act, idx, ruleMeta, catalog, issues));

  return issues;
}

export function validateAutomationRules(
  rules: AutomationRule[],
  catalog?: Catalog
): AutomationValidationReport {
  const errors: AutomationValidationIssue[] = [];
  const warnings: AutomationValidationIssue[] = [];
  const issuesByRuleId: Record<string, AutomationValidationIssue[]> = {};
  const idCounts = new Map<string, number>();

  for (const r of rules) {
    if (r.id) {
      idCounts.set(r.id, (idCounts.get(r.id) || 0) + 1);
    }
  }

  for (const rule of rules) {
    const isDup = Boolean(rule.id && (idCounts.get(rule.id) || 0) > 1);
    const ruleIssues = validateAutomationRule(rule, catalog, isDup);
    if (ruleIssues.length > 0) {
      const key = rule.id || '(missing-id)';
      if (!issuesByRuleId[key]) {
        issuesByRuleId[key] = [];
      }
      for (const issue of ruleIssues) {
        issuesByRuleId[key].push(issue);
        if (issue.type === 'error') {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    hasWarnings: warnings.length > 0,
    errors,
    warnings,
    issuesByRuleId
  };
}

