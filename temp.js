"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.compileToByteMap = compileToByteMap;
exports.compileCondition = compileCondition;
exports.compileAction = compileAction;
exports.compileActionList = compileActionList;
exports.compileAutomationRule = compileAutomationRule;
exports.exportToCandoJson = exportToCandoJson;
exports.exportToFullCatalogJson = exportToFullCatalogJson;
exports.exportToEsp32FirmwareJson = exportToEsp32FirmwareJson;
exports.commandToTrigger = commandToTrigger;
exports.commandToCondition = commandToCondition;
exports.commandToAction = commandToAction;
exports.resolveCatalogCommandForTrigger = resolveCatalogCommandForTrigger;
exports.resolveCatalogCommandForAction = resolveCatalogCommandForAction;
exports.resolveCatalogCommandForCondition = resolveCatalogCommandForCondition;
exports.applyOptionToTrigger = applyOptionToTrigger;
exports.applyOptionToAction = applyOptionToAction;
exports.applyOptionToCondition = applyOptionToCondition;
var defaultCatalog_1 = require("../data/defaultCatalog");
var catalogUtils_1 = require("./catalogUtils");
/**
 * Cleanly compiles any payload or glob into a strict 1-based ByteMap ({ D1: "0x.." })
 */
function compileToByteMap(input) {
    if (!input)
        return {};
    if (typeof input === 'object') {
        var cleanMap = {};
        for (var _i = 0, _a = Object.entries(input); _i < _a.length; _i++) {
            var _b = _a[_i], k = _b[0], v = _b[1];
            if (v && typeof v === 'string' && !v.includes('*') && v !== '?') {
                cleanMap[k] = v.startsWith('0x') || v.startsWith('0X') ? v : "0x".concat(v.toUpperCase());
            }
        }
        return cleanMap;
    }
    var parts = input.trim().split(/\s+/);
    var result = {};
    parts.forEach(function (part, idx) {
        if (idx >= 8)
            return;
        var dKey = "D".concat(idx + 1);
        var clean = part.trim();
        if (!clean || clean === '*' || clean === '**' || clean === '??')
            return;
        var hexClean = clean.replace(/\*/g, '0');
        if (hexClean) {
            var val = hexClean.startsWith('0x') || hexClean.startsWith('0X') ? hexClean : "0x".concat(hexClean.toUpperCase());
            result[dKey] = val;
        }
    });
    return result;
}
/**
 * Compiles a condition into standard CAN Do schema
 */
function compileCondition(cond) {
    var _a, _b, _c, _d, _e, _f;
    if (cond.logic === 'and' || cond.logic === 'or' || cond.logic === 'not') {
        var subConds = (cond.conditions || []).map(compileCondition);
        if (cond.logic === 'and')
            return { and: subConds };
        if (cond.logic === 'or')
            return { or: subConds };
        if (cond.logic === 'not')
            return { not: subConds[0] || {} };
    }
    if (cond.type === 'time_condition' || cond.type === 'time') {
        return {
            type: 'time_condition',
            start_time: cond.start_time || '08:00',
            end_time: cond.end_time || '18:00',
            days: cond.days && cond.days.length > 0 ? cond.days : ['mon', 'tue', 'wed', 'thu', 'fri']
        };
    }
    if (cond.type === 'param_range' || cond.type === 'voltage') {
        return {
            type: 'param_range',
            can_id: cond.can_id || '0x100',
            operator: cond.operator || (cond.voltage_dir === 'above' ? 'greater' : 'less'),
            value: cond.value || cond.voltage_val || '50'
        };
    }
    var match = compileToByteMap(cond.match || ((_a = cond.evaluate) === null || _a === void 0 ? void 0 : _a.match) || cond.payload || cond.match_payload);
    var dKey = cond.byte || ((_b = cond.evaluate) === null || _b === void 0 ? void 0 : _b.byte) || Object.keys(match)[0] || 'D1';
    var targetVal = cond.value || ((_c = cond.evaluate) === null || _c === void 0 ? void 0 : _c.value) || match[dKey] || '0x01';
    var maskVal = cond.mask || ((_d = cond.evaluate) === null || _d === void 0 ? void 0 : _d.mask) || '0xFF';
    var op = cond.operator || ((_e = cond.evaluate) === null || _e === void 0 ? void 0 : _e.operator) || (cond.invert ? 'not_equal' : 'equal');
    return {
        can_id: cond.can_id || '0x000',
        bus: (_f = cond.bus) !== null && _f !== void 0 ? _f : 0,
        byte: dKey,
        mask: maskVal,
        operator: op,
        value: targetVal
    };
}
/**
 * Compiles an AutomationAction into an inlined transmit sequence, delay, if_then, choose, popup, or climate target
 */
function compileAction(act, catalog) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
    if (catalog === void 0) { catalog = defaultCatalog_1.DEFAULT_CATALOG; }
    if (act.type === 'if_then') {
        return {
            type: 'if_then',
            conditions: (act.conditions || []).map(compileCondition),
            then: compileActionList(act.then || [], catalog),
            else: compileActionList(act.else || [], catalog)
        };
    }
    if (act.type === 'choose') {
        return {
            type: 'choose',
            choices: (act.choices || []).map(function (c) { return ({
                conditions: (c.conditions || []).map(compileCondition),
                sequence: compileActionList(c.sequence || [], catalog)
            }); }),
            default: compileActionList(act.default || [], catalog)
        };
    }
    if (act.type === 'delay') {
        return {
            type: 'delay',
            ms: act.delay_ms || act.ms || 500
        };
    }
    if (act.type === 'track_popup' || act.type === 'popup') {
        return {
            type: 'track_popup',
            level: act.level || 'info',
            text: act.text || act.popup_message || ''
        };
    }
    if (act.type === 'climate_target') {
        var isPass = act.zone === 'passenger';
        var tempC = (_b = (_a = act.target_temp_c) !== null && _a !== void 0 ? _a : act.target_c) !== null && _b !== void 0 ? _b : 21.0;
        var clamped = Math.max(17.0, Math.min(27.5, tempC));
        var rawVal = Math.min(0x1A, Math.max(0x06, 0x06 + Math.round((clamped - 17.0) * 2.0)));
        var hexVal = '0x' + rawVal.toString(16).toUpperCase().padStart(2, '0');
        return {
            type: 'transmit',
            can_id: '0x4A0',
            bus: 0,
            payload: isPass ? { D8: hexVal } : { D2: hexVal },
            repeat: 1
        };
    }
    if (act.type === 'precondition') {
        return {
            type: 'precondition',
            mode: act.precon_mode || 'persistent',
            action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
        };
    }
    // Handle entity_command: Inline catalog command definition into native CAN transmit bursts
    if (act.type === 'entity_command' || act.entity_id || act.source_command_id) {
        var entityId_1 = act.entity_id || act.source_command_id;
        var commandLabel = act.command || act.option_label;
        var rawCmd = ((catalog === null || catalog === void 0 ? void 0 : catalog.commands) || []).find(function (c) { return c.id === entityId_1; });
        var cmd_1 = rawCmd ? (0, catalogUtils_1.resolveVariant)(rawCmd, null) : undefined;
        if (cmd_1) {
            if (cmd_1.type === 'climate_target') {
                var isPass = act.zone === 'passenger';
                var tempC = (_d = (_c = act.target_temp_c) !== null && _c !== void 0 ? _c : cmd_1.target_temp_c) !== null && _d !== void 0 ? _d : 21.0;
                var clamped = Math.max(17.0, Math.min(27.5, tempC));
                var rawVal = Math.min(0x1A, Math.max(0x06, 0x06 + Math.round((clamped - 17.0) * 2.0)));
                var hexVal = '0x' + rawVal.toString(16).toUpperCase().padStart(2, '0');
                return {
                    type: 'transmit',
                    can_id: '0x4A0',
                    bus: 0,
                    payload: isPass ? { D8: hexVal } : { D2: hexVal },
                    repeat: 1
                };
            }
            if (cmd_1.type === 'precondition' || cmd_1.id === 'battery_preconditioning') {
                return {
                    type: 'precondition',
                    mode: act.precon_mode || cmd_1.precon_mode || 'persistent',
                    action: act.precon_action || (act.precon_mode === 'cancel' ? 'stop' : 'start')
                };
            }
            // Match designated option using robust matcher
            var opt_1 = findMatchingOptionForAction(cmd_1, act);
            var canId_1 = ((_e = cmd_1.network) === null || _e === void 0 ? void 0 : _e.action_can_id) || cmd_1.action_can_id || ((_f = cmd_1.network) === null || _f === void 0 ? void 0 : _f.state_can_id) || cmd_1.state_can_id || act.can_id || '0x000';
            var bus_1 = (_l = (_k = (_j = (_h = (_g = cmd_1.network) === null || _g === void 0 ? void 0 : _g.bus) !== null && _h !== void 0 ? _h : cmd_1.action_bus) !== null && _j !== void 0 ? _j : cmd_1.bus) !== null && _k !== void 0 ? _k : act.bus) !== null && _l !== void 0 ? _l : 0;
            var delayMs_1 = (_q = (_p = (_o = (_m = cmd_1.network) === null || _m === void 0 ? void 0 : _m.delay_ms) !== null && _o !== void 0 ? _o : cmd_1.delay_ms) !== null && _p !== void 0 ? _p : act.delay_ms) !== null && _q !== void 0 ? _q : 20;
            // Case A: Option defines multi-step burst (e.g. heated/cooled seat sequence)
            if ((opt_1 === null || opt_1 === void 0 ? void 0 : opt_1.steps) && opt_1.steps.length > 0) {
                var inlinedSteps_1 = [];
                opt_1.steps.forEach(function (step, idx) {
                    var _a;
                    var stepPayload = compileToByteMap(step.payload);
                    inlinedSteps_1.push({
                        type: 'transmit',
                        can_id: step.can_id || canId_1,
                        bus: (_a = step.bus) !== null && _a !== void 0 ? _a : bus_1,
                        payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
                        repeat: step.repeat || 1
                    });
                    if (idx < opt_1.steps.length - 1 && delayMs_1 > 0) {
                        inlinedSteps_1.push({
                            type: 'delay',
                            ms: delayMs_1
                        });
                    }
                });
                return inlinedSteps_1;
            }
            // Case B: Option defines a single payload
            if (opt_1 === null || opt_1 === void 0 ? void 0 : opt_1.payload) {
                var p = compileToByteMap(opt_1.payload);
                return {
                    type: 'transmit',
                    can_id: canId_1,
                    bus: bus_1,
                    payload: Object.keys(p).length > 0 ? p : { D1: '0x01' },
                    repeat: opt_1.repeat || 1
                };
            }
            // Case C: Command defines root steps
            if (cmd_1.steps && cmd_1.steps.length > 0) {
                var inlinedSteps_2 = [];
                cmd_1.steps.forEach(function (step, idx) {
                    var _a;
                    var stepPayload = compileToByteMap(step.payload);
                    inlinedSteps_2.push({
                        type: 'transmit',
                        can_id: step.can_id || canId_1,
                        bus: (_a = step.bus) !== null && _a !== void 0 ? _a : bus_1,
                        payload: Object.keys(stepPayload).length > 0 ? stepPayload : { D1: '0x01' },
                        repeat: step.repeat || 1
                    });
                    if (idx < cmd_1.steps.length - 1 && delayMs_1 > 0) {
                        inlinedSteps_2.push({
                            type: 'delay',
                            ms: delayMs_1
                        });
                    }
                });
                return inlinedSteps_2;
            }
            // Case D: Command defines root payload
            if (cmd_1.payload) {
                var p = compileToByteMap(cmd_1.payload);
                return {
                    type: 'transmit',
                    can_id: canId_1,
                    bus: bus_1,
                    payload: Object.keys(p).length > 0 ? p : { D1: '0x01' },
                    repeat: cmd_1.repeat || 1
                };
            }
        }
        // Fallback: If can_id and payload provided, transmit it; otherwise entity_command
        if (act.can_id && act.payload) {
            var payload_1 = compileToByteMap(act.payload || act.to_payload);
            return {
                type: 'transmit',
                can_id: act.can_id,
                bus: (_r = act.bus) !== null && _r !== void 0 ? _r : 0,
                payload: Object.keys(payload_1).length > 0 ? payload_1 : { D1: '0x01' },
                repeat: act.repeat || 1
            };
        }
        return {
            type: 'entity_command',
            entity_id: entityId_1 || '',
            command: commandLabel || ''
        };
    }
    var payload = compileToByteMap(act.payload || act.to_payload);
    return {
        type: 'transmit',
        can_id: act.can_id || '',
        bus: (_s = act.bus) !== null && _s !== void 0 ? _s : 0,
        payload: Object.keys(payload).length > 0 ? payload : {},
        repeat: act.repeat || 1
    };
}
/**
 * Compiles a list of actions, flattening inlined action sequences
 */
function compileActionList(actions, catalog) {
    if (catalog === void 0) { catalog = defaultCatalog_1.DEFAULT_CATALOG; }
    var result = [];
    for (var _i = 0, actions_1 = actions; _i < actions_1.length; _i++) {
        var act = actions_1[_i];
        var compiled = compileAction(act, catalog);
        if (Array.isArray(compiled)) {
            result.push.apply(result, compiled);
        }
        else if (compiled) {
            result.push(compiled);
        }
    }
    return result;
}
/**
 * Compiles a single AutomationRule into a clean, self-contained schema with inlined actions.
 */
function compileAutomationRule(rule, catalog) {
    var _a, _b, _c;
    if (catalog === void 0) { catalog = defaultCatalog_1.DEFAULT_CATALOG; }
    return {
        id: rule.id,
        name: rule.name,
        enabled: (_a = rule.enabled) !== null && _a !== void 0 ? _a : true,
        ha_expose: (_b = rule.ha_expose) !== null && _b !== void 0 ? _b : true,
        ha_icon: rule.ha_icon || 'mdi:car-cog',
        exec_mode: rule.exec_mode || 'one_shot',
        cooldown_ms: (_c = rule.cooldown_ms) !== null && _c !== void 0 ? _c : 500,
        triggers: (rule.triggers || []).map(function (trig) {
            var _a;
            if (trig.type === 'time_schedule' || trig.source === 'time' || trig.time) {
                return {
                    type: 'time_schedule',
                    time: trig.time || '07:30',
                    days: trig.days && trig.days.length > 0 ? trig.days : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
                };
            }
            var targetByte = trig.byte || (trig.match ? Object.keys(trig.match)[0] : undefined) || (trig.byte_index !== undefined ? "D".concat(trig.byte_index + 1) : 'D7');
            var fromHex = trig.from || (trig.from_value !== undefined ? "0x".concat(trig.from_value.toString(16).padStart(2, '0').toUpperCase()) : '0x00');
            var toHex = trig.to || (trig.match && trig.match[targetByte]) || (trig.to_value !== undefined ? "0x".concat(trig.to_value.toString(16).padStart(2, '0').toUpperCase()) : '0x10');
            var maskHex = trig.mask || '0xF0';
            return {
                type: 'byte_transition',
                can_id: trig.can_id || '',
                bus: (_a = trig.bus) !== null && _a !== void 0 ? _a : 0,
                byte: targetByte || '',
                mask: maskHex || '',
                from: fromHex || '',
                to: toHex || ''
            };
        }),
        conditions: (rule.conditions || []).map(compileCondition),
        actions: compileActionList(rule.actions || [], catalog)
    };
}
/**
 * Generate standard WiCAN / CAN Do format strictly matching the exact architecture outcome
 */
function exportToCandoJson(rules, settings, catalog) {
    if (settings === void 0) { settings = {}; }
    if (catalog === void 0) { catalog = defaultCatalog_1.DEFAULT_CATALOG; }
    var exportPayload = {
        settings: {
            vehicle_model: settings.vehicle_model || 'all_egmp',
            unit_system: settings.unit_system || 'imperial',
            firmware_version: settings.firmware_version || '2026.9.1',
            ntp_server: settings.ntp_server || 'pool.ntp.org',
            timezone: settings.timezone || 'UTC'
        },
        rules: rules.map(function (r) { return compileAutomationRule(r, catalog); })
    };
    return JSON.stringify(exportPayload, null, 2);
}
/**
 * Generate full can_do_catalog.json with embedded automations array ready for ESP32 LittleFS.
 *
 * When `vehicle` is provided, commands with `variants` are resolved to that
 * vehicle's family before serialization — the `variants` key is stripped from
 * the output so the firmware parser never sees it and needs no changes.
 * When `vehicle` is omitted the first variant is used as a best-guess fallback
 * (same behaviour as resolveVariant).
 */
function exportToFullCatalogJson(catalog, rules, vehicle) {
    var cleanAutomations = rules.map(function (r) { return compileAutomationRule(r, catalog); });
    // Flatten variants for each command so the ESP32 gets a clean, vehicle-specific catalog
    var resolvedCommands = catalog.commands.map(function (cmd) {
        var resolved = (0, catalogUtils_1.resolveVariant)(cmd, vehicle !== null && vehicle !== void 0 ? vehicle : null);
        // Strip the variants key — the firmware has no use for it
        if (resolved.variants) {
            var _stripped = resolved.variants, clean = __rest(resolved, ["variants"]);
            return clean;
        }
        return resolved;
    });
    return JSON.stringify(__assign(__assign({}, catalog), { commands: resolvedCommands, automations: cleanAutomations }), null, 2);
}
/**
 * Generate compact ESP32 firmware-ready JSON structure (flat, numeric, memory-optimized for C)
 */
function exportToEsp32FirmwareJson(rules, settings, catalog) {
    if (settings === void 0) { settings = {}; }
    if (catalog === void 0) { catalog = defaultCatalog_1.DEFAULT_CATALOG; }
    var modeMap = {
        one_shot: 0,
        toggle: 1,
        continuous_hold: 2,
        on_change: 3,
        poll_verify: 4
    };
    var firmwareRules = rules.map(function (r) {
        var _a;
        var compiled = compileAutomationRule(r, catalog);
        return {
            id: compiled.id,
            name: compiled.name,
            en: compiled.enabled ? 1 : 0,
            mode: (_a = modeMap[compiled.exec_mode]) !== null && _a !== void 0 ? _a : 0,
            trig_op: r.trigger_mode === 'all' ? 1 : 0,
            cd_ms: compiled.cooldown_ms || 500,
            trigs: compiled.triggers.map(function (t) {
                var _a;
                return ({
                    id: "trig_".concat(t.can_id),
                    can_id: t.can_id || '0x000',
                    bus: (_a = t.bus) !== null && _a !== void 0 ? _a : 0,
                    byte: t.byte,
                    mask: t.mask || '0xF0',
                    from: t.from,
                    to: t.to
                });
            }),
            conds: compiled.conditions,
            acts: compiled.actions
        };
    });
    var payload = {
        v: 2,
        vehicle: settings.vehicle_model || 'all_egmp',
        rules: firmwareRules
    };
    return JSON.stringify(payload, null, 2);
}
/**
 * Convert a Catalog Command into an Automation Trigger
 */
function commandToTrigger(rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var trigId = "trig_".concat(cmd.id, "_").concat(Date.now().toString(36).slice(-4));
    var canId = ((_a = cmd.network) === null || _a === void 0 ? void 0 : _a.state_can_id) || cmd.state_can_id || ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.action_can_id) || cmd.action_can_id || '0x448';
    var chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(function (o) { return o.default; }) || cmd.options[0]) : undefined);
    var match = compileToByteMap((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.match) || cmd.match || (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.payload) || cmd.payload);
    var targetByte = Object.keys(match)[0] || 'D7';
    var targetTo = match[targetByte] || '0x10';
    var rawMask = (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.mask) || cmd.mask;
    var targetMask = '0xFF';
    if (typeof rawMask === 'string') {
        targetMask = rawMask;
    }
    else if (rawMask && typeof rawMask === 'object') {
        targetMask = rawMask[targetByte] || '0xFF';
    }
    return {
        id: trigId,
        type: 'byte_transition',
        source: 'can',
        can_id: canId,
        bus: (_e = (_d = (_c = cmd.network) === null || _c === void 0 ? void 0 : _c.bus) !== null && _d !== void 0 ? _d : cmd.bus) !== null && _e !== void 0 ? _e : 0,
        byte: targetByte,
        mask: targetMask,
        from: '0x00',
        to: targetTo,
        click_count: 1,
        for_sec: 0,
        for_ms: 0,
        source_command_id: cmd.id,
        source_command_name: cmd.name || ((_f = cmd.ha_metadata) === null || _f === void 0 ? void 0 : _f.name) || cmd.id,
        option_label: chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label
    };
}
/**
 * Convert a Catalog Command into an Automation Condition
 */
function commandToCondition(rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(function (o) { return o.default; }) || cmd.options[0]) : undefined);
    var condId = "cond_".concat(cmd.id, "_").concat(Date.now().toString(36).slice(-4));
    var canId = ((_a = cmd.network) === null || _a === void 0 ? void 0 : _a.state_can_id) || cmd.state_can_id || ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.action_can_id) || cmd.action_can_id || '0x000';
    var match = compileToByteMap((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.match) || cmd.match || (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.payload) || cmd.payload);
    var cleanMatch = Object.keys(match).length > 0 ? match : { D1: '0x01' };
    var dKey = Object.keys(cleanMatch)[0] || 'D1';
    var targetVal = cleanMatch[dKey] || '0x01';
    var byteIdx = parseInt(dKey.replace(/\D/g, ''), 10) - 1;
    var rawMask = (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.mask) || cmd.mask;
    var targetMask = '0xFF';
    if (typeof rawMask === 'string') {
        targetMask = rawMask;
    }
    else if (rawMask && typeof rawMask === 'object') {
        targetMask = rawMask[dKey] || '0xFF';
    }
    return {
        id: condId,
        type: 'can_state',
        can_id: canId,
        bus: (_e = (_d = (_c = cmd.network) === null || _c === void 0 ? void 0 : _c.bus) !== null && _d !== void 0 ? _d : cmd.bus) !== null && _e !== void 0 ? _e : 0,
        match: cleanMatch,
        byte: dKey,
        mask: targetMask,
        operator: 'equal',
        value: targetVal,
        evaluate: {
            byte: dKey,
            byte_index: isNaN(byteIdx) ? 0 : byteIdx,
            operator: 'equal',
            value: targetVal,
            mask: targetMask
        },
        invert: false,
        source_command_id: cmd.id,
        source_command_name: ((_f = cmd.ha_metadata) === null || _f === void 0 ? void 0 : _f.name) || cmd.name || cmd.id,
        option_label: chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label
    };
}
/**
 * Convert a Catalog Command into an Automation Action
 */
function commandToAction(rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var chosenOpt = opt || (cmd.options && cmd.options.length > 0 ? (cmd.options.find(function (o) { return o.default; }) || cmd.options[0]) : undefined);
    var actId = "act_".concat(cmd.id, "_").concat(Date.now().toString(36).slice(-4));
    var canId = ((_a = cmd.network) === null || _a === void 0 ? void 0 : _a.action_can_id) || cmd.action_can_id || ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.state_can_id) || cmd.state_can_id || '0x000';
    var cmdDisplayName = ((_c = cmd.ha_metadata) === null || _c === void 0 ? void 0 : _c.name) || cmd.name || cmd.id;
    if (cmd.type === 'climate_target') {
        return {
            id: actId,
            type: 'climate_target',
            target_temp_c: (_d = cmd.target_temp_c) !== null && _d !== void 0 ? _d : 21.0,
            zone: cmd.climate_zone || 'driver',
            sync_on: (_e = cmd.climate_sync_on) !== null && _e !== void 0 ? _e : true,
            driver_only: (_f = cmd.climate_driver_only) !== null && _f !== void 0 ? _f : false,
            source_command_id: cmd.id,
            source_command_name: cmdDisplayName
        };
    }
    if (cmd.type === 'precondition' || cmd.id === 'battery_preconditioning') {
        return {
            id: actId,
            type: 'precondition',
            precon_mode: (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.precon_mode) || 'persistent',
            precon_action: (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.precon_mode) === 'cancel' ? 'stop' : 'start',
            source_command_id: cmd.id,
            source_command_name: cmdDisplayName,
            option_label: chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label
        };
    }
    if ((cmd.options && cmd.options.length > 0) || (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label)) {
        var payload_2 = compileToByteMap((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.payload) || ((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.steps) && ((_g = chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.steps[0]) === null || _g === void 0 ? void 0 : _g.payload)) || cmd.payload);
        return {
            id: actId,
            type: 'entity_command',
            entity_id: cmd.id,
            command: (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label) || 'Toggle',
            can_id: canId,
            bus: (_l = (_k = (_j = (_h = cmd.network) === null || _h === void 0 ? void 0 : _h.bus) !== null && _j !== void 0 ? _j : cmd.action_bus) !== null && _k !== void 0 ? _k : cmd.bus) !== null && _l !== void 0 ? _l : 0,
            payload: Object.keys(payload_2).length > 0 ? payload_2 : undefined,
            popup_message: (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.popup) || "".concat(cmdDisplayName, " - ").concat((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label) || 'Toggle'),
            source_command_id: cmd.id,
            source_command_name: cmdDisplayName,
            option_label: chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label
        };
    }
    var payload = compileToByteMap((chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.payload) || cmd.payload || (cmd.steps && ((_m = cmd.steps[0]) === null || _m === void 0 ? void 0 : _m.payload)));
    return {
        id: actId,
        type: 'can_tx',
        can_id: canId,
        bus: (_r = (_q = (_p = (_o = cmd.network) === null || _o === void 0 ? void 0 : _o.bus) !== null && _p !== void 0 ? _p : cmd.action_bus) !== null && _q !== void 0 ? _q : cmd.bus) !== null && _r !== void 0 ? _r : 0,
        payload: Object.keys(payload).length > 0 ? payload : { D1: '0x01' },
        repeat: (chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.repeat) || 1,
        delay_ms: 50,
        source_command_id: cmd.id,
        source_command_name: cmdDisplayName,
        option_label: chosenOpt === null || chosenOpt === void 0 ? void 0 : chosenOpt.label
    };
}
/**
 * Resolves the catalog command and matched option for a trigger.
 * Handles explicit source_command_id, name patterns (e.g. trig_menu_ok -> sw_menu),
 * and reverse lookup by CAN ID & Byte/Mask match.
 */
function resolveCatalogCommandForTrigger(trig, catalog) {
    var _a, _b;
    if (!(catalog === null || catalog === void 0 ? void 0 : catalog.commands))
        return {};
    // 1. Direct ID match
    if (trig.source_command_id) {
        var rawCmd = catalog.commands.find(function (c) { return c.id === trig.source_command_id; });
        if (rawCmd) {
            var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
            var opt = findMatchingOptionForTrigger(cmd, trig);
            return { command: cmd, matchedOption: opt };
        }
    }
    // 2. ID name hint match (e.g. trig_menu_ok -> sw_menu)
    if (trig.id) {
        var lowerId = trig.id.toLowerCase();
        if (lowerId.includes('menu') || lowerId.includes('ok')) {
            var swMenu = catalog.commands.find(function (c) { return c.id === 'sw_menu'; });
            if (swMenu) {
                var cmd = (0, catalogUtils_1.resolveVariant)(swMenu, null);
                var opt = findMatchingOptionForTrigger(cmd, trig);
                return { command: cmd, matchedOption: opt };
            }
        }
    }
    // 3. Match by CAN ID
    if (trig.can_id) {
        var normCanId_1 = trig.can_id.toLowerCase();
        var candidateCmds = catalog.commands.filter(function (c) {
            var _a, _b;
            var stateId = (((_a = c.network) === null || _a === void 0 ? void 0 : _a.state_can_id) || c.state_can_id || '').toLowerCase();
            var actionId = (((_b = c.network) === null || _b === void 0 ? void 0 : _b.action_can_id) || c.action_can_id || '').toLowerCase();
            return stateId === normCanId_1 || actionId === normCanId_1;
        });
        if (candidateCmds.length === 1) {
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            var opt = findMatchingOptionForTrigger(cmd, trig);
            return { command: cmd, matchedOption: opt };
        }
        if (candidateCmds.length > 1) {
            // Find candidate whose options match byte/value
            for (var _i = 0, candidateCmds_1 = candidateCmds; _i < candidateCmds_1.length; _i++) {
                var raw = candidateCmds_1[_i];
                var cmd_2 = (0, catalogUtils_1.resolveVariant)(raw, null);
                var opt = findMatchingOptionForTrigger(cmd_2, trig);
                if (opt) {
                    return { command: cmd_2, matchedOption: opt };
                }
            }
            // Check command-level match
            for (var _c = 0, candidateCmds_2 = candidateCmds; _c < candidateCmds_2.length; _c++) {
                var raw = candidateCmds_2[_c];
                var cmd_3 = (0, catalogUtils_1.resolveVariant)(raw, null);
                if (cmd_3.match && trig.byte && cmd_3.match[trig.byte]) {
                    return { command: cmd_3, matchedOption: (_a = cmd_3.options) === null || _a === void 0 ? void 0 : _a[0] };
                }
            }
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            return { command: cmd, matchedOption: (_b = cmd.options) === null || _b === void 0 ? void 0 : _b[0] };
        }
    }
    return {};
}
function findMatchingOptionForTrigger(cmd, trig) {
    if (!cmd.options || cmd.options.length === 0)
        return undefined;
    if (trig.option_label) {
        var target_1 = trig.option_label.toLowerCase().trim();
        var byLabel = cmd.options.find(function (o) { return o.label.toLowerCase().trim() === target_1; });
        if (byLabel)
            return byLabel;
        var byPartial = cmd.options.find(function (o) {
            var l = o.label.toLowerCase().trim();
            return l.includes(target_1) || target_1.includes(l);
        });
        if (byPartial)
            return byPartial;
    }
    var byteKey = trig.byte || (trig.byte_index !== undefined ? "D".concat(trig.byte_index + 1) : undefined);
    var trigValHex = trig.to
        ? (trig.to.startsWith('0x') ? trig.to : "0x".concat(trig.to)).toLowerCase()
        : trig.to_value !== undefined
            ? "0x".concat(trig.to_value.toString(16).padStart(2, '0')).toLowerCase()
            : undefined;
    for (var _i = 0, _a = cmd.options; _i < _a.length; _i++) {
        var opt = _a[_i];
        if (opt.match && byteKey && opt.match[byteKey]) {
            var optVal = (opt.match[byteKey].startsWith('0x') ? opt.match[byteKey] : "0x".concat(opt.match[byteKey])).toLowerCase();
            if (trigValHex && optVal === trigValHex)
                return opt;
        }
    }
    if (trig.match && typeof trig.match === 'object') {
        var _loop_1 = function (opt) {
            if (opt.match && typeof opt.match === 'object') {
                var matchKeys = Object.keys(trig.match);
                if (matchKeys.length > 0 && matchKeys.every(function (k) { var _a, _b; return ((_a = opt.match) === null || _a === void 0 ? void 0 : _a[k]) === ((_b = trig.match) === null || _b === void 0 ? void 0 : _b[k]); })) {
                    return { value: opt };
                }
            }
        };
        for (var _b = 0, _c = cmd.options; _b < _c.length; _b++) {
            var opt = _c[_b];
            var state_1 = _loop_1(opt);
            if (typeof state_1 === "object")
                return state_1.value;
        }
    }
    return cmd.options.find(function (o) { return o.default; }) || cmd.options[0];
}
/**
 * Resolves the catalog command and matched option for an action.
 */
function resolveCatalogCommandForAction(act, catalog) {
    var _a;
    if (!(catalog === null || catalog === void 0 ? void 0 : catalog.commands))
        return {};
    var targetId = act.source_command_id || act.entity_id;
    if (targetId) {
        var rawCmd = catalog.commands.find(function (c) { return c.id === targetId; });
        if (rawCmd) {
            var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
            var opt = findMatchingOptionForAction(cmd, act);
            return { command: cmd, matchedOption: opt };
        }
    }
    if (act.can_id) {
        var normCanId_2 = act.can_id.toLowerCase();
        var candidateCmds = catalog.commands.filter(function (c) {
            var _a, _b;
            var actionId = (((_a = c.network) === null || _a === void 0 ? void 0 : _a.action_can_id) || c.action_can_id || '').toLowerCase();
            var stateId = (((_b = c.network) === null || _b === void 0 ? void 0 : _b.state_can_id) || c.state_can_id || '').toLowerCase();
            return actionId === normCanId_2 || stateId === normCanId_2;
        });
        if (candidateCmds.length === 1) {
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            var opt = findMatchingOptionForAction(cmd, act);
            return { command: cmd, matchedOption: opt };
        }
        if (candidateCmds.length > 1) {
            for (var _i = 0, candidateCmds_3 = candidateCmds; _i < candidateCmds_3.length; _i++) {
                var raw = candidateCmds_3[_i];
                var cmd_4 = (0, catalogUtils_1.resolveVariant)(raw, null);
                var opt = findMatchingOptionForAction(cmd_4, act);
                if (opt)
                    return { command: cmd_4, matchedOption: opt };
            }
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            return { command: cmd, matchedOption: (_a = cmd.options) === null || _a === void 0 ? void 0 : _a[0] };
        }
    }
    return {};
}
function findMatchingOptionForAction(cmd, act) {
    var _a;
    if (!cmd.options || cmd.options.length === 0)
        return undefined;
    var labelToMatch = act.option_label || act.command;
    if (labelToMatch) {
        var target_2 = labelToMatch.toLowerCase().trim();
        var byExact = cmd.options.find(function (o) { return o.label.toLowerCase().trim() === target_2; });
        if (byExact)
            return byExact;
        var byPartial = cmd.options.find(function (o) {
            var l = o.label.toLowerCase().trim();
            return l === target_2 || l.startsWith(target_2) || target_2.startsWith(l);
        });
        if (byPartial)
            return byPartial;
    }
    if (act.payload && typeof act.payload === 'object') {
        var _loop_2 = function (opt) {
            var optMap = compileToByteMap(opt.payload || (opt.steps && ((_a = opt.steps[0]) === null || _a === void 0 ? void 0 : _a.payload)) || opt.match);
            var optKeys = Object.keys(optMap);
            if (optKeys.length > 0 && optKeys.every(function (k) {
                var aVal = String(act.payload[k] || '').toLowerCase();
                var oVal = String(optMap[k] || '').toLowerCase();
                return aVal === oVal;
            })) {
                return { value: opt };
            }
        };
        for (var _i = 0, _b = cmd.options; _i < _b.length; _i++) {
            var opt = _b[_i];
            var state_2 = _loop_2(opt);
            if (typeof state_2 === "object")
                return state_2.value;
        }
        // If we tried to match a payload and none matched perfectly, don't guess the default option.
        // This prevents trailing sequence steps (like D5: 0xFF) from falsely rendering as "Off".
        return undefined;
    }
    return cmd.options.find(function (o) { return o.default; }) || cmd.options[0];
}
/**
 * Resolves the catalog command and matched option for a condition.
 * Handles explicit source_command_id, ID hints, and CAN ID/byte matching.
 */
function resolveCatalogCommandForCondition(cond, catalog) {
    var _a;
    if (!(catalog === null || catalog === void 0 ? void 0 : catalog.commands))
        return {};
    // 1. Direct ID match
    if (cond.source_command_id) {
        var rawCmd = catalog.commands.find(function (c) { return c.id === cond.source_command_id; });
        if (rawCmd) {
            var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
            var opt = findMatchingOptionForCondition(cmd, cond);
            return { command: cmd, matchedOption: opt };
        }
    }
    // 2. ID name hint match (e.g. cond_gear_drive -> gear_selector)
    if (cond.id) {
        var lowerId = cond.id.toLowerCase();
        for (var _i = 0, _b = catalog.commands; _i < _b.length; _i++) {
            var c = _b[_i];
            if (lowerId.includes(c.id.toLowerCase())) {
                var cmd = (0, catalogUtils_1.resolveVariant)(c, null);
                var opt = findMatchingOptionForCondition(cmd, cond);
                return { command: cmd, matchedOption: opt };
            }
        }
    }
    // 3. Match by CAN ID
    if (cond.can_id) {
        var normCanId_3 = cond.can_id.toLowerCase();
        var candidateCmds = catalog.commands.filter(function (c) {
            var _a, _b;
            var stateId = (((_a = c.network) === null || _a === void 0 ? void 0 : _a.state_can_id) || c.state_can_id || '').toLowerCase();
            var actionId = (((_b = c.network) === null || _b === void 0 ? void 0 : _b.action_can_id) || c.action_can_id || '').toLowerCase();
            return stateId === normCanId_3 || actionId === normCanId_3;
        });
        if (candidateCmds.length === 1) {
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            var opt = findMatchingOptionForCondition(cmd, cond);
            return { command: cmd, matchedOption: opt };
        }
        if (candidateCmds.length > 1) {
            for (var _c = 0, candidateCmds_4 = candidateCmds; _c < candidateCmds_4.length; _c++) {
                var raw = candidateCmds_4[_c];
                var cmd_5 = (0, catalogUtils_1.resolveVariant)(raw, null);
                var opt = findMatchingOptionForCondition(cmd_5, cond);
                if (opt)
                    return { command: cmd_5, matchedOption: opt };
            }
            var cmd = (0, catalogUtils_1.resolveVariant)(candidateCmds[0], null);
            return { command: cmd, matchedOption: (_a = cmd.options) === null || _a === void 0 ? void 0 : _a[0] };
        }
    }
    return {};
}
function findMatchingOptionForCondition(cmd, cond) {
    var _a, _b;
    if (!cmd.options || cmd.options.length === 0)
        return undefined;
    if (cond.option_label) {
        var target_3 = cond.option_label.toLowerCase().trim();
        var byLabel = cmd.options.find(function (o) { return o.label.toLowerCase().trim() === target_3; });
        if (byLabel)
            return byLabel;
        var byPartial = cmd.options.find(function (o) {
            var l = o.label.toLowerCase().trim();
            return l.includes(target_3) || target_3.includes(l);
        });
        if (byPartial)
            return byPartial;
    }
    var byteKey = cond.byte || ((_a = cond.evaluate) === null || _a === void 0 ? void 0 : _a.byte) || (cond.match ? Object.keys(cond.match)[0] : undefined);
    var targetVal = cond.value || ((_b = cond.evaluate) === null || _b === void 0 ? void 0 : _b.value) || (byteKey && cond.match ? cond.match[byteKey] : undefined);
    var targetHex = targetVal
        ? (targetVal.startsWith('0x') || targetVal.startsWith('0X') ? targetVal : "0x".concat(targetVal)).toLowerCase()
        : undefined;
    if (byteKey && targetHex) {
        for (var _i = 0, _c = cmd.options; _i < _c.length; _i++) {
            var opt = _c[_i];
            var match = compileToByteMap(opt.match || opt.payload);
            if (match[byteKey] && match[byteKey].toLowerCase() === targetHex) {
                return opt;
            }
        }
    }
    return cmd.options.find(function (o) { return o.default; }) || cmd.options[0];
}
/**
 * Apply a selected catalog option to a trigger
 */
function applyOptionToTrigger(trig, rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload);
    var dKey = Object.keys(cleanMatch)[0] || 'D7';
    var targetTo = cleanMatch[dKey] || '0x10';
    var byteNum = parseInt(dKey.replace(/\D/g, ''), 10);
    var byteIdx = isNaN(byteNum) ? 6 : byteNum - 1;
    var rawMask = opt.mask || cmd.mask;
    var targetMask = '0xFF';
    if (typeof rawMask === 'string') {
        targetMask = rawMask;
    }
    else if (rawMask && typeof rawMask === 'object') {
        targetMask = rawMask[dKey] || '0xFF';
    }
    var toVal = parseInt(targetTo.replace('0x', ''), 16);
    var friendlyName = cmd.id === 'sw_menu' ? 'Menu / OK Button' : (((_a = cmd.ha_metadata) === null || _a === void 0 ? void 0 : _a.name) || cmd.name || cmd.id);
    return __assign(__assign({}, trig), { source_command_id: cmd.id, source_command_name: friendlyName, option_label: opt.label, can_id: ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.state_can_id) || cmd.state_can_id || trig.can_id || '0x448', bus: (_f = (_e = (_d = (_c = cmd.network) === null || _c === void 0 ? void 0 : _c.bus) !== null && _d !== void 0 ? _d : cmd.bus) !== null && _e !== void 0 ? _e : trig.bus) !== null && _f !== void 0 ? _f : 0, byte: dKey, byte_index: byteIdx, mask: targetMask, to: targetTo, to_value: isNaN(toVal) ? undefined : toVal, match: cleanMatch, to_payload: cleanMatch });
}
/**
 * Apply a selected catalog option to an action
 */
function applyOptionToAction(act, rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var canId = ((_a = cmd.network) === null || _a === void 0 ? void 0 : _a.action_can_id) || cmd.action_can_id || ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.state_can_id) || cmd.state_can_id || act.can_id || '0x000';
    var cmdDisplayName = ((_c = cmd.ha_metadata) === null || _c === void 0 ? void 0 : _c.name) || cmd.name || cmd.id;
    var payload = compileToByteMap(opt.payload || (opt.steps && ((_d = opt.steps[0]) === null || _d === void 0 ? void 0 : _d.payload)) || cmd.payload);
    if (act.type === 'entity_command' || (cmd.options && cmd.options.length > 0)) {
        return __assign(__assign({}, act), { source_command_id: cmd.id, source_command_name: cmdDisplayName, entity_id: cmd.id, command: opt.label, option_label: opt.label, can_id: canId, bus: (_j = (_h = (_g = (_f = (_e = cmd.network) === null || _e === void 0 ? void 0 : _e.bus) !== null && _f !== void 0 ? _f : cmd.action_bus) !== null && _g !== void 0 ? _g : cmd.bus) !== null && _h !== void 0 ? _h : act.bus) !== null && _j !== void 0 ? _j : 0, payload: Object.keys(payload).length > 0 ? payload : act.payload, popup_message: opt.popup || "".concat(cmdDisplayName, " - ").concat(opt.label) });
    }
    return __assign(__assign({}, act), { source_command_id: cmd.id, source_command_name: cmdDisplayName, command: opt.label, option_label: opt.label, can_id: canId, bus: (_p = (_o = (_m = (_l = (_k = cmd.network) === null || _k === void 0 ? void 0 : _k.bus) !== null && _l !== void 0 ? _l : cmd.action_bus) !== null && _m !== void 0 ? _m : cmd.bus) !== null && _o !== void 0 ? _o : act.bus) !== null && _p !== void 0 ? _p : 0, payload: Object.keys(payload).length > 0 ? payload : act.payload, popup_message: opt.popup || act.popup_message });
}
/**
 * Apply a selected catalog option to a condition
 */
function applyOptionToCondition(cond, rawCmd, opt) {
    var _a, _b, _c, _d, _e, _f, _g;
    var cmd = (0, catalogUtils_1.resolveVariant)(rawCmd, null);
    var cleanMatch = compileToByteMap(opt.match || opt.payload || cmd.match || cmd.payload);
    var dKey = Object.keys(cleanMatch)[0] || cond.byte || 'D1';
    var targetVal = cleanMatch[dKey] || '0x01';
    var byteNum = parseInt(dKey.replace(/\D/g, ''), 10);
    var byteIdx = isNaN(byteNum) ? 0 : byteNum - 1;
    var rawMask = opt.mask || cmd.mask;
    var targetMask = '0xFF';
    if (typeof rawMask === 'string') {
        targetMask = rawMask;
    }
    else if (rawMask && typeof rawMask === 'object') {
        targetMask = rawMask[dKey] || '0xFF';
    }
    var friendlyName = ((_a = cmd.ha_metadata) === null || _a === void 0 ? void 0 : _a.name) || cmd.name || cmd.id;
    return __assign(__assign({}, cond), { source_command_id: cmd.id, source_command_name: friendlyName, option_label: opt.label, can_id: ((_b = cmd.network) === null || _b === void 0 ? void 0 : _b.state_can_id) || cmd.state_can_id || ((_c = cmd.network) === null || _c === void 0 ? void 0 : _c.action_can_id) || cmd.action_can_id || cond.can_id || '0x000', bus: (_g = (_f = (_e = (_d = cmd.network) === null || _d === void 0 ? void 0 : _d.bus) !== null && _e !== void 0 ? _e : cmd.bus) !== null && _f !== void 0 ? _f : cond.bus) !== null && _g !== void 0 ? _g : 0, byte: dKey, mask: targetMask, match: cleanMatch, operator: 'equal', value: targetVal, evaluate: {
            byte: dKey,
            byte_index: byteIdx,
            operator: 'equal',
            value: targetVal,
            mask: targetMask
        }, invert: false });
}
