import React, { useId } from 'react';
import {
  EV6_FASCIA,
  GV60_FASCIA,
  IONIQ5_FASCIA,
  IONIQ6_FASCIA,
  type BeamRectSpec,
} from './frontFasciaPaths';
import {
  EV6_REAR_CHARGING,
  GV60_REAR_CHARGING,
  IONIQ5_REAR_CHARGING,
  IONIQ6_REAR_CHARGING,
  SHARED_FLIP_CHARGE_DOOR,
  SHARED_SIDE_J1772,
} from './rearChargingPaths';

export type EgmpModel = 'ioniq5' | 'ev6' | 'ioniq6' | 'gv60';

export interface ModelSpec {
  id: EgmpModel;
  name: string;
  brand: string;
}

export const EGMP_MODELS: Record<EgmpModel, ModelSpec> = {
  ioniq5: {
    id: 'ioniq5',
    name: 'Ioniq 5',
    brand: 'Hyundai',
  },
  ev6: {
    id: 'ev6',
    name: 'EV6',
    brand: 'Kia',
  },
  ioniq6: {
    id: 'ioniq6',
    name: 'Ioniq 6',
    brand: 'Hyundai',
  },
  gv60: {
    id: 'gv60',
    name: 'GV60',
    brand: 'Genesis',
  },
};

function renderSideJ1772(opts: {
  prefix: 'ioniq5' | 'ioniq6' | 'gv60';
  transform: string;
  isCharging: boolean;
  cableFadeId: string;
  energyFadeId: string;
  glowId: string;
  flowClass: string;
}) {
  const { prefix, transform, isCharging, cableFadeId, energyFadeId, glowId, flowClass } = opts;
  return (
    <g id={`${prefix}-j1772`} transform={transform}>
      <g id={`${prefix}-j1772-strain-relief`}>
        <path
          d={SHARED_SIDE_J1772.strainRelief.bootPath}
          fill="#27272a"
          stroke="var(--foreground)"
          strokeOpacity={0.75}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.strainRelief.shellPath}
          fill="var(--surface-secondary)"
          stroke="var(--foreground)"
          strokeOpacity={0.75}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.strainRelief.highlightPath}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g id={`${prefix}-j1772-nozzle-and-latch`}>
        <path
          d={SHARED_SIDE_J1772.nozzleLatchPath}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={0.55}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g id={`${prefix}-j1772-release-button`}>
        <path
          d={SHARED_SIDE_J1772.releaseButton.bodyPath}
          fill="#27272a"
          stroke="var(--foreground)"
          strokeOpacity={0.75}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.releaseButton.highlightPath}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g id={`${prefix}-j1772-body-and-grip`}>
        <path
          d={SHARED_SIDE_J1772.bodyAndGrip.topLinePath}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={0.75}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.bodyAndGrip.chinPath}
          fill="#27272a"
          stroke="var(--foreground)"
          strokeOpacity={0.75}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.bodyAndGrip.chinHighlightPath}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {SHARED_SIDE_J1772.bodyAndGrip.upperDetailPaths.map((d, idx) => (
          <path
            key={`${prefix}-j1772-up-${idx}`}
            d={d}
            fill="none"
            stroke="var(--foreground)"
            strokeOpacity={0.55}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        <path
          d={SHARED_SIDE_J1772.bodyAndGrip.gripPadPath}
          fill="#27272a"
          stroke="var(--foreground)"
          strokeOpacity={0.6}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SHARED_SIDE_J1772.bodyAndGrip.lowerDetailPath}
          fill="none"
          stroke="var(--foreground)"
          strokeOpacity={0.55}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g id={`${prefix}-j1772-cable`}>
        <path
          d={SHARED_SIDE_J1772.cablePath}
          fill={`url(#${cableFadeId})`}
          stroke={`url(#${cableFadeId})`}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {isCharging && (
          <path
            id={`${prefix}-cable-energy`}
            d={SHARED_SIDE_J1772.cableFlowPath}
            fill="none"
            stroke={`url(#${energyFadeId})`}
            strokeWidth={20}
            strokeLinecap="round"
            strokeDasharray="40 80"
            className={flowClass}
            filter={`url(#${glowId})`}
          />
        )}
      </g>
    </g>
  );
}

function renderFlipChargeDoor(opts: { id: string; bodyUrl: string; transform?: string }) {
  return (
    <g id={opts.id} transform={opts.transform}>
      <path
        d={SHARED_FLIP_CHARGE_DOOR.lidPath}
        fill={opts.bodyUrl}
        stroke="var(--foreground)"
        strokeOpacity={0.75}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={SHARED_FLIP_CHARGE_DOOR.hingePath}
        fill="#27272a"
        stroke="var(--foreground)"
        strokeOpacity={0.6}
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

export interface RearChargingViewProps {
  model: EgmpModel;
  soc: number | null;
  chargeRateKw: number;
  lights: 'off' | 'parking' | 'low' | 'high' | 'auto';
  trunkOpen?: boolean;
  isCharging?: boolean;
  hazards?: boolean;
  turnSignal?: 'off' | 'left' | 'right';
  blinkState?: boolean;
  onClick?: () => void;
}

export const VehicleRearChargingView: React.FC<RearChargingViewProps> = ({
  model,
  soc,
  chargeRateKw,
  lights,
  trunkOpen = false,
  isCharging = false,
  hazards = false,
  turnSignal = 'off',
  blinkState = false,
  onClick
}) => {
  const uid = useId().replace(/:/g, '');

  if (model === 'ev6') {
    const isTailOn = lights !== 'off';
    const leftBlink = Boolean((hazards || turnSignal === 'left') && blinkState);
    const rightBlink = Boolean((hazards || turnSignal === 'right') && blinkState);
    const tailLensFill = isTailOn ? '#7f1d1d' : '#450a0a';
    const tailLensOpacity = isTailOn ? 0.94 : 0.78;
    const centerLedStroke = isTailOn ? '#ef4444' : '#991b1b';
    const centerLedOpacity = isTailOn ? 0.96 : 0.45;
    const leftLedStroke = leftBlink ? '#f59e0b' : centerLedStroke;
    const leftLedOpacity = leftBlink ? 0.98 : centerLedOpacity;
    const rightLedStroke = rightBlink ? '#f59e0b' : centerLedStroke;
    const rightLedOpacity = rightBlink ? 0.98 : centerLedOpacity;
    const bodyUrl = `url(#${uid}-body)`;

    return (
      <button
        id="hero-rear-charging-silhouette"
        type="button"
        onClick={onClick}
        aria-label={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} charging rear view${soc !== null ? `, ${soc}% battery` : ''}${chargeRateKw > 0 ? `, ${chargeRateKw} kilowatts` : ''}`}
        className="group relative w-full flex items-center justify-center bg-transparent border-0 p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl cursor-pointer select-none"
      >
        <svg
          id="ev6-rear-view"
          viewBox={EV6_REAR_CHARGING.viewBox}
          className="w-full h-auto max-h-[155px] block overflow-visible"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <clipPath id={`${uid}-clip-fender-left`}>
              <path d={EV6_REAR_CHARGING.clipFenderLeftPath} />
            </clipPath>
            <clipPath id={`${uid}-clip-fender-right`}>
              <path d={EV6_REAR_CHARGING.clipFenderRightPath} />
            </clipPath>
            <linearGradient id={`${uid}-body`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--surface-secondary)" />
              <stop offset="100%" stopColor="color-mix(in oklab, var(--foreground) 6%, var(--surface))" />
            </linearGradient>
            <linearGradient id={`${uid}-cable-fade`} gradientUnits="userSpaceOnUse" x1="2486" y1="594" x2="2517" y2="769.6">
              <stop offset="0%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="82%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="100%" stopColor="#27272a" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${uid}-energy-fade`} gradientUnits="userSpaceOnUse" x1="2486" y1="594" x2="2517" y2="769.6">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
              <stop offset="82%" stopColor="#34d399" stopOpacity={0.85} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
            <filter id={`${uid}-red-glow`} x="-25%" y="-60%" width="150%" height="220%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={`${uid}-emerald-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <style>
              {`
                @keyframes ev6-rear-soc-pulse {
                  0%, 100% { opacity: 0.35; }
                  50% { opacity: 1; }
                }
                @keyframes ev6-rear-cable-flow {
                  0% { stroke-dashoffset: 36; }
                  100% { stroke-dashoffset: 0; }
                }
                @media (prefers-reduced-motion: no-preference) {
                  .ev6-rear-soc-pulse {
                    animation: ev6-rear-soc-pulse 1.8s ease-in-out infinite;
                  }
                  .ev6-rear-cable-flow {
                    animation: ev6-rear-cable-flow 1.6s linear infinite;
                  }
                }
              `}
            </style>
          </defs>

          <g id="ev6">
            <g id="ev6-body">
              <path
                id="main-body"
                d={EV6_REAR_CHARGING.body.mainBody}
                fill={bodyUrl}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {EV6_REAR_CHARGING.body.tailgateSeams.map((d, idx) => (
                <path
                  key={`ev6-tailgate-seam-${idx}`}
                  d={d}
                  fill="none"
                  stroke={trunkOpen ? '#f59e0b' : 'var(--foreground)'}
                  strokeOpacity={trunkOpen ? 0.95 : 0.75}
                  strokeWidth={trunkOpen ? 3.5 : 2.5}
                  strokeDasharray={trunkOpen ? '8 5' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {EV6_REAR_CHARGING.body.majorSeams.map((d, idx) => (
                <path
                  key={`ev6-major-seam-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.75}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {EV6_REAR_CHARGING.body.detailSeams.map((d, idx) => (
                <path
                  key={`ev6-detail-seam-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              <path
                id="ev6-charge-port-recess"
                d={EV6_REAR_CHARGING.body.chargePortRecess}
                fill="#1e2229"
                stroke="var(--foreground)"
                strokeOpacity={0.65}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>

            <g
              id="ev6-rear-emblem"
              transform={EV6_REAR_CHARGING.emblemTransform}
              className={trunkOpen ? 'text-amber-500/80 dark:text-amber-400/80' : 'text-foreground/60'}
            >
              {EV6_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`ev6-rear-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>

            <g id="ev6-center-leds" transform={EV6_REAR_CHARGING.centerLeds.transform}>
              <path
                id="ev6-center-lens"
                d={EV6_REAR_CHARGING.centerLeds.lensPath}
                fill={tailLensFill}
                fillOpacity={tailLensOpacity}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2}
              />
              <path
                id="ev6-center-led-h-strip"
                d={EV6_REAR_CHARGING.centerLeds.hStripPath}
                fill="none"
                stroke={centerLedStroke}
                strokeOpacity={centerLedOpacity}
                strokeWidth={2}
                filter={isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
              <path
                id="ev6-center-led-v-strip"
                d={EV6_REAR_CHARGING.centerLeds.vStripPath}
                fill="none"
                stroke={centerLedStroke}
                strokeOpacity={centerLedOpacity}
                strokeWidth={9}
                strokeDasharray="4.5 5"
                filter={isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
            </g>

            <g id="ev6-left-tail-light">
              <path
                d={EV6_REAR_CHARGING.leftTailLight.lensPath}
                fill={tailLensFill}
                fillOpacity={tailLensOpacity}
                fillRule="nonzero"
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={EV6_REAR_CHARGING.leftTailLight.stripPath}
                fill="none"
                stroke={leftLedStroke}
                strokeOpacity={leftLedOpacity}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                filter={leftBlink || isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
              <path
                d={EV6_REAR_CHARGING.leftTailLight.dashPath}
                fill="none"
                stroke={leftLedStroke}
                strokeOpacity={leftLedOpacity}
                strokeWidth={34}
                strokeDasharray="5.5 7.5"
                clipPath={`url(#${uid}-clip-fender-left)`}
                filter={leftBlink || isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
            </g>

            <g id="ev6-right-tail-light">
              <path
                d={EV6_REAR_CHARGING.rightTailLight.lensPath}
                fill={tailLensFill}
                fillOpacity={tailLensOpacity}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2}
              />
              <path
                d={EV6_REAR_CHARGING.rightTailLight.stripPath}
                fill="none"
                stroke={rightLedStroke}
                strokeOpacity={rightLedOpacity}
                strokeWidth={2}
                filter={rightBlink || isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
              <path
                d={EV6_REAR_CHARGING.rightTailLight.dashPath}
                fill="none"
                stroke={rightLedStroke}
                strokeOpacity={rightLedOpacity}
                strokeWidth={34}
                strokeDasharray="5.5 7.5"
                clipPath={`url(#${uid}-clip-fender-right)`}
                filter={rightBlink || isTailOn ? `url(#${uid}-red-glow)` : undefined}
              />
            </g>

            <g id="ev6-charging-interface">
              <rect
                id="ev6-ccs-port"
                x={EV6_REAR_CHARGING.chargingInterface.ccsPort.x}
                y={EV6_REAR_CHARGING.chargingInterface.ccsPort.y}
                width={EV6_REAR_CHARGING.chargingInterface.ccsPort.width}
                height={EV6_REAR_CHARGING.chargingInterface.ccsPort.height}
                rx={EV6_REAR_CHARGING.chargingInterface.ccsPort.rx}
                ry={EV6_REAR_CHARGING.chargingInterface.ccsPort.rx}
                fill="#334155"
                stroke="#1e293b"
                strokeWidth={1.5}
              />
              <g id="ev6-charging-indicators" transform={EV6_REAR_CHARGING.chargingInterface.subTransform}>
                {EV6_REAR_CHARGING.chargingInterface.indicators.map((ind, i) => {
                  const low = i * 25;
                  const high = (i + 1) * 25;
                  const isSolid = soc !== null && (soc >= high || (!isCharging && soc > low));
                  const isPulsing = Boolean(isCharging) && (soc === null ? i === 0 : soc >= low && soc < high);
                  const isLit = isSolid || isPulsing;
                  return (
                    <path
                      key={ind.id}
                      id={ind.id}
                      d={ind.d}
                      fill={isLit ? '#34d399' : '#3f4654'}
                      stroke="#18181b"
                      strokeWidth={1}
                      className={isPulsing ? 'ev6-rear-soc-pulse' : undefined}
                      filter={isLit ? `url(#${uid}-emerald-glow)` : undefined}
                    />
                  );
                })}
              </g>
              <g id="ev6-buttons" transform={EV6_REAR_CHARGING.chargingInterface.subTransform}>
                {EV6_REAR_CHARGING.chargingInterface.buttons.map(btn => (
                  <rect
                    key={btn.id}
                    id={btn.id}
                    x={btn.x}
                    y={btn.y}
                    width={btn.size}
                    height={btn.size}
                    rx={btn.rx}
                    ry={btn.rx}
                    fill="#64748b"
                    stroke="#1e293b"
                    strokeWidth={1}
                  />
                ))}
              </g>
            </g>

            <g id="ev6-j1772" transform={EV6_REAR_CHARGING.j1772.transform}>
              <g id="ev6-j1772-handle">
                <path
                  d={EV6_REAR_CHARGING.j1772.shellOuterPath}
                  fill="var(--surface-secondary)"
                  stroke="var(--foreground)"
                  strokeOpacity={0.75}
                  strokeWidth={0.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={EV6_REAR_CHARGING.j1772.shellCapPath}
                  fill="var(--surface-secondary)"
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={0.55}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {EV6_REAR_CHARGING.j1772.accentFillPaths.map((d, idx) => (
                  <path
                    key={`ev6-j1772-accent-${idx}`}
                    d={d}
                    fill="#27272a"
                    stroke="var(--foreground)"
                    strokeOpacity={0.55}
                    strokeWidth={0.55}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                {EV6_REAR_CHARGING.j1772.detailStrokePaths.map((d, idx) => (
                  <path
                    key={`ev6-j1772-detail-${idx}`}
                    d={d}
                    fill="none"
                    stroke="var(--foreground)"
                    strokeOpacity={0.6}
                    strokeWidth={0.55}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ))}
                <ellipse
                  cx={EV6_REAR_CHARGING.j1772.grommet.cx}
                  cy={EV6_REAR_CHARGING.j1772.grommet.cy}
                  rx={EV6_REAR_CHARGING.j1772.grommet.rx}
                  ry={EV6_REAR_CHARGING.j1772.grommet.ry}
                  fill="#71717a"
                  stroke="var(--foreground)"
                  strokeOpacity={0.5}
                  strokeWidth={0.5}
                />
              </g>
              <path
                id="ev6-cable"
                d={EV6_REAR_CHARGING.j1772.cablePath}
                fill={`url(#${uid}-cable-fade)`}
                stroke={`url(#${uid}-cable-fade)`}
                strokeWidth={0.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {isCharging && (
                <path
                  id="ev6-cable-energy"
                  d={EV6_REAR_CHARGING.j1772.cableFlowPath}
                  fill="none"
                  stroke={`url(#${uid}-energy-fade)`}
                  strokeWidth={3.2}
                  strokeLinecap="round"
                  strokeDasharray="6 12"
                  className="ev6-rear-cable-flow"
                  filter={`url(#${uid}-emerald-glow)`}
                />
              )}
            </g>

            <g id="ev6-charge-door-open" transform={EV6_REAR_CHARGING.chargeDoorOpen.transform}>
              {EV6_REAR_CHARGING.chargeDoorOpen.paths.slice(0, 7).map((p, idx) => (
                <path
                  key={`ev6-door-path-${idx}`}
                  d={p.d}
                  fill={p.filled ? bodyUrl : 'none'}
                  stroke="var(--foreground)"
                  strokeOpacity={p.width >= 2.5 ? 0.75 : 0.45}
                  strokeWidth={p.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              <rect
                x={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.x}
                y={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.y}
                width={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.width}
                height={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.height}
                rx={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.rx}
                transform={EV6_REAR_CHARGING.chargeDoorOpen.detailRect.transform}
                fill={bodyUrl}
                stroke="var(--foreground)"
                strokeOpacity={0.45}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {EV6_REAR_CHARGING.chargeDoorOpen.paths.slice(7).map((p, idx) => (
                <path
                  key={`ev6-door-after-${idx}`}
                  d={p.d}
                  fill={p.filled ? bodyUrl : 'none'}
                  stroke="var(--foreground)"
                  strokeOpacity={p.width >= 2.5 ? 0.75 : 0.45}
                  strokeWidth={p.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          </g>
        </svg>
      </button>
    );
  }

  if (model === 'ioniq5') {
    const isTailOn = lights !== 'off';
    const leftBlink = Boolean((hazards || turnSignal === 'left') && blinkState);
    const rightBlink = Boolean((hazards || turnSignal === 'right') && blinkState);
    const baseTailStroke = isTailOn ? '#ef4444' : '#991b1b';
    const baseTailOpacity = isTailOn ? 0.96 : 0.45;
    const bodyUrl = `url(#${uid}-body)`;
    const lampClusters = [
      { id: 'lamp-outer-left', spec: IONIQ5_REAR_CHARGING.pixelTaillights.outerLeft, blink: leftBlink },
      { id: 'lamp-inner-left', spec: IONIQ5_REAR_CHARGING.pixelTaillights.innerLeft, blink: false },
      { id: 'lamp-inner-right', spec: IONIQ5_REAR_CHARGING.pixelTaillights.innerRight, blink: false },
      { id: 'lamp-outer-right', spec: IONIQ5_REAR_CHARGING.pixelTaillights.outerRight, blink: rightBlink },
    ] as const;

    return (
      <button
        id="hero-rear-charging-silhouette"
        type="button"
        onClick={onClick}
        aria-label={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} charging rear view${soc !== null ? `, ${soc}% battery` : ''}${chargeRateKw > 0 ? `, ${chargeRateKw} kilowatts` : ''}`}
        className="group relative w-full flex items-center justify-center bg-transparent border-0 p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl cursor-pointer select-none"
      >
        <svg
          id="ioniq5-rear-view"
          viewBox={IONIQ5_REAR_CHARGING.viewBox}
          className="w-full h-auto max-h-[155px] block overflow-visible"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id={`${uid}-body`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--surface-secondary)" />
              <stop offset="100%" stopColor="color-mix(in oklab, var(--foreground) 6%, var(--surface))" />
            </linearGradient>
            <linearGradient id={`${uid}-i5-cable-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
              <stop offset="0%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="86%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="100%" stopColor="#27272a" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${uid}-i5-energy-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
              <stop offset="84%" stopColor="#34d399" stopOpacity={0.85} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
            <filter id={`${uid}-red-glow`} x="-25%" y="-60%" width="150%" height="220%">
              <feGaussianBlur stdDeviation="7" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={`${uid}-emerald-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <style>
              {`
                @keyframes i5-rear-cable-flow {
                  0% { stroke-dashoffset: 240; }
                  100% { stroke-dashoffset: 0; }
                }
                @media (prefers-reduced-motion: no-preference) {
                  .i5-rear-cable-flow {
                    animation: i5-rear-cable-flow 1.6s linear infinite;
                  }
                }
              `}
            </style>
          </defs>

          <g id="ioniq5">
            {/* Plugged J1772 handle + cable rendered behind rear quarter fender */}
            {renderSideJ1772({
              prefix: 'ioniq5',
              transform: IONIQ5_REAR_CHARGING.j1772.transform,
              isCharging,
              cableFadeId: `${uid}-i5-cable-fade`,
              energyFadeId: `${uid}-i5-energy-fade`,
              glowId: `${uid}-emerald-glow`,
              flowClass: 'i5-rear-cable-flow',
            })}

            {/* Body shell first to mask nozzle behind fender, then interior creases */}
            <g id="body-contours" transform={IONIQ5_REAR_CHARGING.bodyTransform}>
              <path
                d={IONIQ5_REAR_CHARGING.bodyContours.mainBody}
                fill={bodyUrl}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {IONIQ5_REAR_CHARGING.bodyContours.seams.map((d, idx) => (
                <path
                  key={`i5-contour-seam-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.6}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            <g id="light-bar-frame" transform={IONIQ5_REAR_CHARGING.bodyTransform}>
              <path
                d={IONIQ5_REAR_CHARGING.lightBarFrame.housingPath}
                fill="#181c24"
                fillOpacity={0.86}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {IONIQ5_REAR_CHARGING.lightBarFrame.creasePaths.map((d, idx) => (
                <path
                  key={`i5-lightbar-crease-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            <g id="pixel-taillights" transform={IONIQ5_REAR_CHARGING.bodyTransform}>
              <g id="center-grid">
                {IONIQ5_REAR_CHARGING.pixelTaillights.centerGrid.map((d, idx) => (
                  <path
                    key={`i5-center-grid-${idx}`}
                    d={d}
                    fill="none"
                    stroke="#64748b"
                    strokeOpacity={0.42}
                    strokeWidth={1.5}
                    strokeLinecap="square"
                  />
                ))}
              </g>
              {lampClusters.map(({ id, spec, blink }) => {
                const strokeColor = blink ? '#f59e0b' : baseTailStroke;
                const strokeOpacity = blink ? 0.98 : baseTailOpacity;
                const glowFilter = blink || isTailOn ? `url(#${uid}-red-glow)` : undefined;
                return (
                  <g key={id} id={id}>
                    <path
                      d={spec.h}
                      fill="none"
                      stroke={strokeColor}
                      strokeOpacity={strokeOpacity}
                      strokeWidth={7}
                      strokeDasharray="7 3"
                      filter={glowFilter}
                    />
                    <path
                      d={spec.v}
                      fill="none"
                      stroke={strokeColor}
                      strokeOpacity={strokeOpacity}
                      strokeWidth={7}
                      strokeDasharray="7 4"
                      filter={glowFilter}
                    />
                    <path
                      d={spec.grid}
                      fill="none"
                      stroke="#64748b"
                      strokeOpacity={0.42}
                      strokeWidth={1.5}
                      strokeLinecap="square"
                    />
                  </g>
                );
              })}
            </g>

            <g id="tailgate" transform={IONIQ5_REAR_CHARGING.bodyTransform}>
              {IONIQ5_REAR_CHARGING.tailgateSeams.map((d, idx) => (
                <path
                  key={`i5-tailgate-${idx}`}
                  d={d}
                  fill="none"
                  stroke={trunkOpen ? '#f59e0b' : 'var(--foreground)'}
                  strokeOpacity={trunkOpen ? 0.95 : 0.65}
                  strokeWidth={trunkOpen ? 3.5 : 2.5}
                  strokeDasharray={trunkOpen ? '8 5' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            <g
              id="ioniq5-rear-emblem"
              transform={IONIQ5_REAR_CHARGING.emblemTransform}
              className={trunkOpen ? 'text-amber-500/80 dark:text-amber-400/80' : 'text-foreground/60'}
            >
              {IONIQ5_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`ioniq5-rear-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>

            <g id="ioniq5-lower-bumper" transform={IONIQ5_REAR_CHARGING.bodyTransform}>
              {IONIQ5_REAR_CHARGING.lowerBumper.contourPaths.map((d, idx) => (
                <path
                  key={`i5-bumper-contour-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.7}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {IONIQ5_REAR_CHARGING.lowerBumper.louverPaths.map((d, idx) => (
                <path
                  key={`i5-bumper-louver-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1.5}
                  strokeLinecap="square"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            {renderFlipChargeDoor({ id: 'ioniq5-charge-door-open', bodyUrl })}
          </g>
        </svg>
      </button>
    );
  }

  if (model === 'ioniq6') {
    const isTailOn = lights !== 'off';
    const leftBlink = Boolean((hazards || turnSignal === 'left') && blinkState);
    const rightBlink = Boolean((hazards || turnSignal === 'right') && blinkState);
    const pixelFill = isTailOn ? '#ef4444' : '#7f1d1d';
    const pixelOpacity = isTailOn ? 0.96 : 0.5;
    const pixelGlow = isTailOn ? `url(#${uid}-red-glow)` : undefined;
    const bodyUrl = `url(#${uid}-body)`;
    const { centerSpec } = IONIQ6_REAR_CHARGING.tailLights;

    return (
      <button
        id="hero-rear-charging-silhouette"
        type="button"
        onClick={onClick}
        aria-label={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} charging rear view${soc !== null ? `, ${soc}% battery` : ''}${chargeRateKw > 0 ? `, ${chargeRateKw} kilowatts` : ''}`}
        className="group relative w-full flex items-center justify-center bg-transparent border-0 p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl cursor-pointer select-none"
      >
        <svg
          id="ioniq6-rear-view"
          viewBox={IONIQ6_REAR_CHARGING.viewBox}
          className="w-full h-auto max-h-[155px] block overflow-visible"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id={`${uid}-body`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--surface-secondary)" />
              <stop offset="100%" stopColor="color-mix(in oklab, var(--foreground) 6%, var(--surface))" />
            </linearGradient>
            <linearGradient id={`${uid}-i6-cable-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
              <stop offset="0%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="86%" stopColor="#27272a" stopOpacity={1} />
              <stop offset="100%" stopColor="#27272a" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${uid}-i6-energy-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
              <stop offset="84%" stopColor="#34d399" stopOpacity={0.85} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
            <filter id={`${uid}-red-glow`} x="-25%" y="-60%" width="150%" height="220%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={`${uid}-emerald-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <style>
              {`
                @keyframes i6-rear-cable-flow {
                  0% { stroke-dashoffset: 240; }
                  100% { stroke-dashoffset: 0; }
                }
                @media (prefers-reduced-motion: no-preference) {
                  .i6-rear-cable-flow {
                    animation: i6-rear-cable-flow 1.6s linear infinite;
                  }
                }
              `}
            </style>
          </defs>

          <g id="ioniq6">
            <g id="ioniq6-body">
              <path
                d={IONIQ6_REAR_CHARGING.body.mainBody}
                fill={bodyUrl}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {IONIQ6_REAR_CHARGING.body.shoulderSeams.map((d, idx) => (
                <path
                  key={`i6-shoulder-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.6}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              <path
                d={IONIQ6_REAR_CHARGING.body.spoilerPath}
                fill={bodyUrl}
                stroke="var(--foreground)"
                strokeOpacity={0.75}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>

            <g id="charge-port" transform={IONIQ6_REAR_CHARGING.groupTransform}>
              <path
                d={IONIQ6_REAR_CHARGING.chargePortPath}
                fill="#1e2229"
                stroke="var(--foreground)"
                strokeOpacity={0.7}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>

            <g id="ioniq6-lightbar-trim" transform={IONIQ6_REAR_CHARGING.groupTransform}>
              {IONIQ6_REAR_CHARGING.lightBarTrimPaths.map((d, idx) => (
                <path
                  key={`i6-trim-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            <g id="ioniq6-tail-lights" transform={IONIQ6_REAR_CHARGING.groupTransform}>
              <g id="ioniq6-lamp-corner-left">
                <path
                  d={IONIQ6_REAR_CHARGING.tailLights.cornerLeftPath}
                  fill={isTailOn ? '#7f1d1d' : '#450a0a'}
                  fillOpacity={isTailOn ? 0.82 : 0.6}
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={1.75}
                  strokeLinecap="square"
                />
              </g>

              {[
                {
                  id: 'ioniq6-left-pixels',
                  transform: IONIQ6_REAR_CHARGING.tailLights.leftPixelsTransform,
                  upper: IONIQ6_REAR_CHARGING.tailLights.leftPixelsUpper,
                  lower: IONIQ6_REAR_CHARGING.tailLights.leftPixelsLower,
                  blink: leftBlink,
                  prefix: 'px-r',
                  isRight: false,
                },
                {
                  id: 'ioniq6-right-pixels',
                  transform: IONIQ6_REAR_CHARGING.tailLights.rightPixelsTransform,
                  upper: IONIQ6_REAR_CHARGING.tailLights.rightPixelsUpper,
                  lower: IONIQ6_REAR_CHARGING.tailLights.rightPixelsLower,
                  blink: rightBlink,
                  prefix: 'px-r-r',
                  isRight: true,
                },
              ].map(side => (
                <g key={side.id} id={side.id} transform={side.transform}>
                  <g id={`${side.id}-upper`} filter={pixelGlow}>
                    {side.upper.map((pts, idx) => (
                      <polygon
                        key={`${side.id}-u-${idx}`}
                        id={`${side.isRight ? 'px-r-r1-c' : 'px-r1-c'}${idx + 1}`}
                        points={pts}
                        fill={pixelFill}
                        fillOpacity={pixelOpacity}
                        stroke="var(--foreground)"
                        strokeOpacity={0.55}
                        strokeWidth={1}
                      />
                    ))}
                  </g>
                  <g id={`${side.id}-lower`} filter={side.blink ? `url(#${uid}-red-glow)` : undefined}>
                    {side.lower.map((pts, idx) => (
                      <polygon
                        key={`${side.id}-l-${idx}`}
                        id={`${side.isRight ? 'px-r-r2-c' : 'px-r2-c'}${idx + 1}`}
                        points={pts}
                        fill={side.blink ? '#f59e0b' : '#1e2229'}
                        fillOpacity={side.blink ? 0.98 : 0.55}
                        stroke="var(--foreground)"
                        strokeOpacity={0.55}
                        strokeWidth={1}
                      />
                    ))}
                  </g>
                </g>
              ))}

              <g id="ioniq6-lamp-center" transform={IONIQ6_REAR_CHARGING.tailLights.centerTransform} filter={pixelGlow}>
                <g id="ioniq6-lamp-center-upper">
                  {Array.from({ length: centerSpec.count }, (_, idx) => (
                    <rect
                      key={`px-c-r1-c${idx + 1}`}
                      id={`px-c-r1-c${idx + 1}`}
                      x={centerSpec.startX + idx * centerSpec.stepX}
                      y={centerSpec.upperY}
                      width={centerSpec.size}
                      height={centerSpec.size}
                      fill={pixelFill}
                      fillOpacity={pixelOpacity}
                      stroke="var(--foreground)"
                      strokeOpacity={0.5}
                      strokeWidth={0.93}
                    />
                  ))}
                </g>
                <g id="ioniq6-lamp-center-lower">
                  {Array.from({ length: centerSpec.count }, (_, idx) => (
                    <rect
                      key={`px-c-r2-c${idx + 1}`}
                      id={`px-c-r2-c${idx + 1}`}
                      x={centerSpec.startX + idx * centerSpec.stepX}
                      y={centerSpec.lowerY}
                      width={centerSpec.size}
                      height={centerSpec.size}
                      fill={pixelFill}
                      fillOpacity={pixelOpacity}
                      stroke="var(--foreground)"
                      strokeOpacity={0.5}
                      strokeWidth={0.93}
                    />
                  ))}
                </g>
              </g>

              <g id="ioniq6-lamp-corner-right">
                <path
                  d={IONIQ6_REAR_CHARGING.tailLights.cornerRightPath}
                  fill={isTailOn ? '#7f1d1d' : '#450a0a'}
                  fillOpacity={isTailOn ? 0.82 : 0.6}
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={1.75}
                  strokeLinecap="square"
                />
              </g>
            </g>

            <g id="lower-trim" transform={IONIQ6_REAR_CHARGING.groupTransform}>
              {IONIQ6_REAR_CHARGING.lowerTrim.plinthPaths.map((d, idx) => (
                <path
                  key={`i6-plinth-${idx}`}
                  d={d}
                  fill="none"
                  stroke={trunkOpen ? '#f59e0b' : 'var(--foreground)'}
                  strokeOpacity={trunkOpen ? 0.95 : 0.65}
                  strokeWidth={trunkOpen ? 3.5 : 2.5}
                  strokeDasharray={trunkOpen ? '8 5' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {IONIQ6_REAR_CHARGING.lowerTrim.bumperPaths.map((d, idx) => (
                <path
                  key={`i6-bumper-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.7}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>

            <g
              id="ioniq6-rear-emblem"
              transform={IONIQ6_REAR_CHARGING.emblemTransform}
              className={trunkOpen ? 'text-amber-500/80 dark:text-amber-400/80' : 'text-foreground/60'}
            >
              {IONIQ6_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`ioniq6-rear-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>

            {renderSideJ1772({
              prefix: 'ioniq6',
              transform: IONIQ6_REAR_CHARGING.j1772Transform,
              isCharging,
              cableFadeId: `${uid}-i6-cable-fade`,
              energyFadeId: `${uid}-i6-energy-fade`,
              glowId: `${uid}-emerald-glow`,
              flowClass: 'i6-rear-cable-flow',
            })}

            {renderFlipChargeDoor({
              id: 'ioniq6-charge-door-open',
              bodyUrl,
              transform: IONIQ6_REAR_CHARGING.chargeDoorTransform,
            })}
          </g>
        </svg>
      </button>
    );
  }

  // Genesis GV60 rear charging view (all 4 E-GMP models use dedicated tail-centered rear views)
  const isTailOn = lights !== 'off';
  const leftBlink = Boolean((hazards || turnSignal === 'left') && blinkState);
  const rightBlink = Boolean((hazards || turnSignal === 'right') && blinkState);
  const bodyUrl = `url(#${uid}-body)`;
  const gv60Lamps = [
    { id: 'lamp-left-upper', spec: GV60_REAR_CHARGING.taillights.leftUpper, blink: false },
    { id: 'lamp-left-lower', spec: GV60_REAR_CHARGING.taillights.leftLower, blink: leftBlink },
    { id: 'lamp-right-upper', spec: GV60_REAR_CHARGING.taillights.rightUpper, blink: false },
    { id: 'lamp-right-lower', spec: GV60_REAR_CHARGING.taillights.rightLower, blink: rightBlink },
  ] as const;

  return (
    <button
      id="hero-rear-charging-silhouette"
      type="button"
      onClick={onClick}
      aria-label={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} charging rear view${soc !== null ? `, ${soc}% battery` : ''}${chargeRateKw > 0 ? `, ${chargeRateKw} kilowatts` : ''}`}
      className="group relative w-full flex items-center justify-center bg-transparent border-0 p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl cursor-pointer select-none"
    >
      <svg
        id="gv60-rear-view"
        viewBox={GV60_REAR_CHARGING.viewBox}
        className="w-full h-auto max-h-[155px] block overflow-visible"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id={`${uid}-body`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--surface-secondary)" />
            <stop offset="100%" stopColor="color-mix(in oklab, var(--foreground) 6%, var(--surface))" />
          </linearGradient>
          <linearGradient id={`${uid}-gv60-cable-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
            <stop offset="0%" stopColor="#27272a" stopOpacity={1} />
            <stop offset="86%" stopColor="#27272a" stopOpacity={1} />
            <stop offset="100%" stopColor="#27272a" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={`${uid}-gv60-energy-fade`} gradientUnits="userSpaceOnUse" x1="904" y1="638" x2="-250.2" y2="2313.9">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
            <stop offset="84%" stopColor="#34d399" stopOpacity={0.85} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
          <filter id={`${uid}-red-glow`} x="-25%" y="-60%" width="150%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id={`${uid}-emerald-glow`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <style>
            {`
              @keyframes gv60-rear-cable-flow {
                0% { stroke-dashoffset: 240; }
                100% { stroke-dashoffset: 0; }
              }
              @media (prefers-reduced-motion: no-preference) {
                .gv60-rear-cable-flow {
                  animation: gv60-rear-cable-flow 1.6s linear infinite;
                }
              }
            `}
          </style>
        </defs>

        <g id="gv60">
          {/* Open charge door and plugged J1772 rendered behind right quarter fender */}
          {renderFlipChargeDoor({
            id: 'gv60-charge-door',
            bodyUrl,
            transform: GV60_REAR_CHARGING.chargeDoorTransform,
          })}
          {renderSideJ1772({
            prefix: 'gv60',
            transform: GV60_REAR_CHARGING.j1772Transform,
            isCharging,
            cableFadeId: `${uid}-gv60-cable-fade`,
            energyFadeId: `${uid}-gv60-energy-fade`,
            glowId: `${uid}-emerald-glow`,
            flowClass: 'gv60-rear-cable-flow',
          })}

          <g id="gv60-body">
            <path
              d={GV60_REAR_CHARGING.body.mainBody}
              fill={bodyUrl}
              stroke="var(--foreground)"
              strokeOpacity={0.75}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {GV60_REAR_CHARGING.body.bumperMajorSeams.map((d, idx) => (
              <path
                key={`gv60-bumper-major-${idx}`}
                d={d}
                fill="none"
                stroke="var(--foreground)"
                strokeOpacity={0.7}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            <path
              d={GV60_REAR_CHARGING.body.bumperDetailSeam}
              fill="none"
              stroke="var(--foreground)"
              strokeOpacity={0.45}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <g id="gv60-shoulder-accents" transform={GV60_REAR_CHARGING.groupTransform}>
              {GV60_REAR_CHARGING.body.shoulderAccents.map((d, idx) => (
                <path
                  key={`gv60-shoulder-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.45}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
            <g id="rear-spoiler" transform={GV60_REAR_CHARGING.groupTransform}>
              {GV60_REAR_CHARGING.rearSpoiler.wingPaths.map((d, idx) => (
                <path
                  key={`gv60-wing-${idx}`}
                  d={d}
                  fill="none"
                  stroke="var(--foreground)"
                  strokeOpacity={0.7}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              <g id="lamp-chmsl">
                <path
                  d={GV60_REAR_CHARGING.rearSpoiler.chmslPath}
                  fill={isTailOn ? '#991b1b' : '#450a0a'}
                  fillOpacity={isTailOn ? 0.85 : 0.45}
                  stroke="var(--foreground)"
                  strokeOpacity={0.65}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </g>
          </g>

          <g id="taillights" transform={GV60_REAR_CHARGING.groupTransform}>
            {gv60Lamps.map(({ id, spec, blink }) => (
              <g key={id} id={id}>
                <path
                  d={spec.housing}
                  fill={isTailOn || blink ? '#7f1d1d' : '#450a0a'}
                  fillOpacity={isTailOn || blink ? 0.92 : 0.72}
                  stroke="var(--foreground)"
                  strokeOpacity={0.75}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={spec.led}
                  fill={blink ? '#f59e0b' : isTailOn ? '#ef4444' : '#991b1b'}
                  fillOpacity={blink ? 0.98 : isTailOn ? 0.95 : 0.45}
                  stroke="var(--foreground)"
                  strokeOpacity={0.55}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter={blink || isTailOn ? `url(#${uid}-red-glow)` : undefined}
                />
              </g>
            ))}
          </g>

          <g
            id="gv60-rear-emblem"
            transform={GV60_REAR_CHARGING.emblemTransform}
            className={trunkOpen ? 'text-amber-500/80 dark:text-amber-400/80' : 'text-foreground/60'}
          >
            <path d={GV60_FASCIA.emblemPath} fill="currentColor" />
          </g>

          <g id="gv60-tailgate-seams">
            {GV60_REAR_CHARGING.tailgateSeams.map((d, idx) => (
              <path
                key={`gv60-tailgate-${idx}`}
                d={d}
                fill="none"
                stroke={trunkOpen ? '#f59e0b' : 'var(--foreground)'}
                strokeOpacity={trunkOpen ? 0.95 : 0.7}
                strokeWidth={trunkOpen ? 3.5 : 2.5}
                strokeDasharray={trunkOpen ? '8 5' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </g>
        </g>
      </svg>
    </button>
  );
};

export interface FrontFasciaHeadlightProps {
  model: EgmpModel;
  lights: 'off' | 'parking' | 'low' | 'high' | 'auto';
  gear?: 'P' | 'R' | 'N' | 'D' | null;
  hazards: boolean;
  turnSignal: 'off' | 'left' | 'right';
  blinkState: boolean;
  hoodOpen?: boolean;
  onClick?: () => void;
}

export const FrontFasciaHeadlightSignature: React.FC<FrontFasciaHeadlightProps> = ({
  model,
  lights,
  gear = 'P',
  hazards,
  turnSignal,
  blinkState,
  hoodOpen = false,
  onClick
}) => {
  const isDrlOn = lights !== 'off';
  const isMainBeamOn =
    lights === 'low' ||
    lights === 'high' ||
    (lights === 'auto' && gear !== 'P');
  const isHighBeam = lights === 'high';

  const leftBlink = (hazards || turnSignal === 'left') && blinkState;
  const rightBlink = (hazards || turnSignal === 'right') && blinkState;

  const signatureTitle =
    model === 'ev6'
      ? 'Digital Tiger Face'
      : model === 'gv60'
        ? 'Two-Line Quad Lamps'
        : model === 'ioniq5'
          ? 'Parametric Pixel DRL'
          : 'Pixel Matrix Headlamps';

  const beamLabel =
    lights === 'off'
      ? 'Lights Off'
      : lights === 'parking'
        ? 'DRL / Parking'
        : lights === 'low'
          ? 'Low Beam'
          : lights === 'high'
            ? 'High Beam'
            : gear !== 'P'
              ? 'Auto · Active'
              : 'Auto · Standby';

  const leftDrlClass = leftBlink
    ? 'text-amber-500 dark:text-amber-400'
    : isDrlOn
      ? 'text-sky-500 dark:text-sky-100'
      : 'text-foreground/30';

  const rightDrlClass = rightBlink
    ? 'text-amber-500 dark:text-amber-400'
    : isDrlOn
      ? 'text-sky-500 dark:text-sky-100'
      : 'text-foreground/30';

  const lowBeamClass = isHighBeam
    ? 'text-sky-600 dark:text-white'
    : isMainBeamOn
      ? 'text-sky-500 dark:text-sky-200'
      : 'text-foreground/20';

  const highBeamClass = isHighBeam
    ? 'text-sky-600 dark:text-white'
    : isMainBeamOn
      ? 'text-sky-500/60 dark:text-sky-200/55'
      : 'text-foreground/20';

  const housingClass = hoodOpen
    ? 'text-amber-500/80 dark:text-amber-400/80'
    : 'text-foreground/25';

  const emblemClass = hoodOpen
    ? 'text-amber-500/75 dark:text-amber-400/75'
    : 'text-foreground/45';

  const viewBox =
    model === 'gv60'
      ? GV60_FASCIA.viewBox
      : model === 'ioniq6'
        ? IONIQ6_FASCIA.viewBox
        : model === 'ioniq5'
          ? IONIQ5_FASCIA.viewBox
          : EV6_FASCIA.viewBox;

  const renderBeamRect = (
    spec: BeamRectSpec,
    id: string,
    isActive: boolean,
    fillOpacity: number,
    strokeWidth: number,
    withGlow: boolean
  ) => (
    <rect
      id={id}
      x={spec.x}
      y={spec.y}
      width={spec.width}
      height={spec.height}
      rx={spec.rx}
      ry={spec.rx}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      fill={isActive ? 'currentColor' : 'none'}
      fillOpacity={isActive ? fillOpacity : 0}
      filter={withGlow ? 'url(#fasciaLedGlow)' : undefined}
    />
  );

  return (
    <button
      id="hero-headlight-silhouette"
      type="button"
      onClick={onClick}
      aria-label={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} ${signatureTitle}: ${beamLabel}. Click to cycle lights preview.`}
      title={`${EGMP_MODELS[model].brand} ${EGMP_MODELS[model].name} · ${signatureTitle} (${beamLabel}) — Click to cycle`}
      className="group relative w-full flex items-center justify-center bg-transparent border-0 p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-xl cursor-pointer select-none"
    >
      <svg
        viewBox={viewBox}
        className="w-full h-auto max-h-[108px] block overflow-visible transition-opacity duration-200 opacity-95 group-hover:opacity-100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="fasciaLedGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="20" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* GENESIS GV60 — Two-Line MLA Quad Lamps */}
        {model === 'gv60' && (
          <g id="fascia-gv60">
            <path
              id="gv60-emblem"
              d={GV60_FASCIA.emblemPath}
              fill="currentColor"
              className={emblemClass}
            />
            {[
              { side: 'left', blink: leftBlink, drlClass: leftDrlClass, transform: undefined },
              { side: 'right', blink: rightBlink, drlClass: rightDrlClass, transform: GV60_FASCIA.rightMirrorTransform }
            ].map(({ side, blink, drlClass, transform }) => (
              <g key={`gv60-lamp-${side}`} id={`gv60-headlight-${side}`} transform={transform}>
                <g
                  id={`gv60-drl-${side}`}
                  className={drlClass}
                  filter={isDrlOn || blink ? 'url(#fasciaLedGlow)' : undefined}
                >
                  {GV60_FASCIA.drlPaths.map((d, idx) => (
                    <path
                      key={`gv60-drl-${side}-${idx}`}
                      d={d}
                      stroke="currentColor"
                      strokeWidth={10}
                      strokeLinejoin="round"
                      fill={isDrlOn || blink ? 'currentColor' : 'none'}
                      fillOpacity={isDrlOn || blink ? 0.88 : 0}
                    />
                  ))}
                </g>
                <g id={`gv60-housings-${side}`} className={housingClass}>
                  {GV60_FASCIA.housingPaths.map((d, idx) => (
                    <path
                      key={`gv60-housing-${side}-${idx}`}
                      d={d}
                      stroke="currentColor"
                      strokeWidth={10}
                      strokeLinejoin="round"
                      fill="none"
                    />
                  ))}
                </g>
                <g id={`gv60-beams-${side}`}>
                  <g
                    id={side === 'left' ? 'gv60-low-beam-left' : 'gv60-low-beams-right'}
                    className={lowBeamClass}
                    filter={isMainBeamOn ? 'url(#fasciaLedGlow)' : undefined}
                  >
                    {GV60_FASCIA.lowBeamPaths.map((d, idx) => (
                      <path
                        key={`gv60-low-${side}-${idx}`}
                        d={d}
                        stroke="currentColor"
                        strokeWidth={10}
                        strokeLinejoin="round"
                        fill={isMainBeamOn ? 'currentColor' : 'none'}
                        fillOpacity={isHighBeam ? 0.92 : isMainBeamOn ? 0.82 : 0}
                      />
                    ))}
                  </g>
                  <g
                    id={side === 'left' ? 'gv60-high-beam-left' : 'gv60-high-beams-right'}
                    className={highBeamClass}
                    filter={isHighBeam ? 'url(#fasciaLedGlow)' : undefined}
                  >
                    {GV60_FASCIA.highBeamPaths.map((d, idx) => (
                      <path
                        key={`gv60-high-${side}-${idx}`}
                        d={d}
                        stroke="currentColor"
                        strokeWidth={10}
                        strokeLinejoin="round"
                        fill={isMainBeamOn ? 'currentColor' : 'none'}
                        fillOpacity={isHighBeam ? 0.96 : isMainBeamOn ? 0.14 : 0}
                      />
                    ))}
                  </g>
                </g>
              </g>
            ))}
          </g>
        )}

        {/* HYUNDAI IONIQ 6 — Pixel Matrix Headlamps */}
        {model === 'ioniq6' && (
          <g id="fascia-ioniq6">
            <g id="ioniq6-emblem" transform={IONIQ6_FASCIA.emblemTransform} className={emblemClass}>
              {IONIQ6_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`i6-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>
            {[
              { side: 'left', blink: leftBlink, drlClass: leftDrlClass, transform: IONIQ6_FASCIA.leftTransform },
              { side: 'right', blink: rightBlink, drlClass: rightDrlClass, transform: IONIQ6_FASCIA.rightTransform }
            ].map(({ side, blink, drlClass, transform }) => (
              <g key={`i6-lamp-${side}`} id={`ioniq6-headlight-${side}`} transform={transform}>
                <g id={`ioniq6-housing-${side}`} className={housingClass}>
                  {IONIQ6_FASCIA.housingPaths.map((d, idx) => (
                    <path
                      key={`i6-housing-${side}-${idx}`}
                      d={d}
                      fill="none"
                      fillRule="evenodd"
                      stroke="currentColor"
                      strokeLinejoin="round"
                      strokeWidth={10}
                    />
                  ))}
                </g>
                <g
                  id={`ioniq6-drl-${side}`}
                  transform={IONIQ6_FASCIA.drlGroupTransform}
                  className={drlClass}
                  filter={isDrlOn || blink ? 'url(#fasciaLedGlow)' : undefined}
                >
                  {IONIQ6_FASCIA.drlRectPositions.map(([x, y], idx) => (
                    <rect
                      key={`i6-drl-${side}-${idx}`}
                      x={x}
                      y={y}
                      width={50}
                      height={50}
                      rx={5}
                      ry={5}
                      stroke="currentColor"
                      strokeWidth={6}
                      fill={isDrlOn || blink ? 'currentColor' : 'none'}
                      fillOpacity={isDrlOn || blink ? 0.9 : 0}
                    />
                  ))}
                </g>
                <g id={`ioniq6-beams-${side}`}>
                  <g className={lowBeamClass}>
                    {renderBeamRect(
                      IONIQ6_FASCIA.lowBeam,
                      `ioniq6-low-beam-${side}`,
                      isMainBeamOn,
                      isHighBeam ? 0.92 : 0.82,
                      8,
                      isMainBeamOn
                    )}
                  </g>
                  <g className={highBeamClass}>
                    {renderBeamRect(
                      IONIQ6_FASCIA.highBeam,
                      `ioniq6-high-beam-${side}`,
                      isMainBeamOn,
                      isHighBeam ? 0.96 : 0.14,
                      8,
                      isHighBeam
                    )}
                  </g>
                </g>
                <g
                  id={`ioniq6-pixels-upper-${side}`}
                  transform={IONIQ6_FASCIA.upperPixelsTransform}
                  className={drlClass}
                  opacity={isDrlOn || blink ? 0.88 : 0.28}
                  filter={isDrlOn || blink ? 'url(#fasciaLedGlow)' : undefined}
                >
                  {IONIQ6_FASCIA.upperPixelRects.map(([x, y, width, height], idx) => (
                    <rect
                      key={`i6-px-${side}-${idx}`}
                      x={x}
                      y={y}
                      width={width}
                      height={height}
                      fill="currentColor"
                    />
                  ))}
                </g>
              </g>
            ))}
          </g>
        )}

        {/* HYUNDAI IONIQ 5 — Parametric Pixel DRL & Dual Projectors */}
        {model === 'ioniq5' && (
          <g id="fascia-ioniq5">
            <g id="ioniq5-emblem" className={emblemClass}>
              {IONIQ5_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`i5-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>
            <g id="ioniq5-headlight-left">
              <g id="ioniq5-beams-left">
                <g className={lowBeamClass}>
                  {renderBeamRect(
                    IONIQ5_FASCIA.leftLowBeam,
                    'ioniq5-low-beam-left',
                    isMainBeamOn,
                    isHighBeam ? 0.92 : 0.82,
                    12,
                    isMainBeamOn
                  )}
                </g>
                <g className={highBeamClass}>
                  {renderBeamRect(
                    IONIQ5_FASCIA.leftHighBeam,
                    'ioniq5-high-beam-left',
                    isMainBeamOn,
                    isHighBeam ? 0.96 : 0.14,
                    12,
                    isHighBeam
                  )}
                </g>
              </g>
              <g
                id="ioniq5-drl-left"
                className={leftDrlClass}
                filter={isDrlOn || leftBlink ? 'url(#fasciaLedGlow)' : undefined}
              >
                {IONIQ5_FASCIA.leftDrlPaths.map((d, idx) => (
                  <path key={`i5-drl-l-${idx}`} d={d} fill="currentColor" fillRule="evenodd" />
                ))}
              </g>
            </g>
            <g id="ioniq5-headlight-right">
              <g id="ioniq5-beams-right">
                <g className={lowBeamClass}>
                  {renderBeamRect(
                    IONIQ5_FASCIA.rightLowBeam,
                    'ioniq5-low-beam-right',
                    isMainBeamOn,
                    isHighBeam ? 0.92 : 0.82,
                    12,
                    isMainBeamOn
                  )}
                </g>
                <g className={highBeamClass}>
                  {renderBeamRect(
                    IONIQ5_FASCIA.rightHighBeam,
                    'ioniq5-high-beam-right',
                    isMainBeamOn,
                    isHighBeam ? 0.96 : 0.14,
                    12,
                    isHighBeam
                  )}
                </g>
              </g>
              <g
                id="ioniq5-drl-right"
                className={rightDrlClass}
                filter={isDrlOn || rightBlink ? 'url(#fasciaLedGlow)' : undefined}
              >
                {IONIQ5_FASCIA.rightDrlPaths.map((d, idx) => (
                  <path key={`i5-drl-r-${idx}`} d={d} fill="currentColor" fillRule="evenodd" />
                ))}
              </g>
            </g>
          </g>
        )}

        {/* KIA EV6 — Digital Tiger Face Sequential DRLs */}
        {model === 'ev6' && (
          <g id="fascia-ev6">
            <g id="ev6-emblem" transform="translate(-3.5, 0)" className={emblemClass}>
              {EV6_FASCIA.emblemPaths.map((d, idx) => (
                <path key={`ev6-emblem-${idx}`} d={d} fill="currentColor" />
              ))}
            </g>
            {[
              { side: 'left', blink: leftBlink, drlClass: leftDrlClass, transform: EV6_FASCIA.leftTransform },
              { side: 'right', blink: rightBlink, drlClass: rightDrlClass, transform: EV6_FASCIA.rightTransform }
            ].map(({ side, blink, drlClass, transform }) => (
              <g key={`ev6-lamp-${side}`} id={`ev6-headlight-${side}`} transform={transform}>
                <g id={`ev6-beams-${side}`}>
                  <g className={highBeamClass}>
                    {renderBeamRect(
                      EV6_FASCIA.highBeam,
                      `ev6-high-beam-${side}`,
                      isMainBeamOn,
                      isHighBeam ? 0.96 : 0.14,
                      10,
                      isHighBeam
                    )}
                  </g>
                  <g className={lowBeamClass}>
                    {renderBeamRect(
                      EV6_FASCIA.lowBeam,
                      `ev6-low-beam-${side}`,
                      isMainBeamOn,
                      isHighBeam ? 0.92 : 0.82,
                      10,
                      isMainBeamOn
                    )}
                  </g>
                </g>
                <g
                  id={`ev6-drl-${side}`}
                  className={drlClass}
                  filter={isDrlOn || blink ? 'url(#fasciaLedGlow)' : undefined}
                >
                  {EV6_FASCIA.drlPaths.map((d, idx) => (
                    <path key={`ev6-drl-${side}-${idx}`} d={d} fill="currentColor" />
                  ))}
                </g>
              </g>
            ))}
          </g>
        )}
      </svg>
    </button>
  );
};
