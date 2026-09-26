import { Command, Catalog, ValidationIssue, CatalogValidationReport, Vehicle } from '../types/catalog';

// Helper to validate single hex byte or wildcard
export function isValidPayloadToken(token: string): boolean {
  if (!token) return false;
  // full wildcard
  if (token === '*') return true;
  // nibble wildcard: *0, 0*, *A, F*
  if (/^(\*[0-9A-Fa-f]|[0-9A-Fa-f]\*)$/.test(token)) return true;
  // negated byte: !00, !12, !FF
  if (/^![0-9A-Fa-f]{2}$/.test(token)) return true;
  // exact hex byte
  if (/^[0-9A-Fa-f]{2}$/.test(token)) return true;
  return false;
}

// Validates a full space-separated payload string
export function validatePayloadString(payloadStr: string | undefined): { isValid: boolean; byteCount: number; error?: string } {
  if (!payloadStr || payloadStr.trim() === '') {
    return { isValid: true, byteCount: 0 };
  }

  const tokens = payloadStr.trim().split(/\s+/);
  if (tokens.length > 8) {
    return {
      isValid: false,
      byteCount: tokens.length,
      error: `Payload exceeds 8 bytes standard CAN frame limit (${tokens.length} bytes detected)`
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

// Validates either a space-separated string or a D1..D8 ByteMap
export function validatePayload(payload: string | Record<string, string> | undefined): { isValid: boolean; byteCount: number; error?: string } {
  if (!payload) return { isValid: true, byteCount: 0 };
  if (typeof payload === 'object') {
    const keys = Object.keys(payload);
    for (const k of keys) {
      if (!/^D[1-8]$/.test(k)) {
        return { isValid: false, byteCount: keys.length, error: `Invalid byte key '${k}'. Must be D1 through D8.` };
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
          if (!step.payload) {
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
        });
      }
    });
  }

  // Steps validation
  if (command.steps && command.steps.length > 0) {
    command.steps.forEach((step, idx) => {
      if (!step.payload || (typeof step.payload === 'string' && step.payload.trim() === '')) {
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
