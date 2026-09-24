import React from 'react';

export type EgmpModel = 'ioniq5' | 'ev6' | 'ioniq6' | 'gv60';

export interface SunroofConfig {
  equipped: boolean; // Has glass sunroof/vision roof vs solid steel roof
  state: 'closed' | 'vent' | 'open'; // For tilt/slide models (EV6, Ioniq 6)
  sunshade: 'open' | 'closed'; // Power roller blind / fabric shade
}

export interface ModelSpec {
  id: EgmpModel;
  name: string;
  brand: string;
  badge: string;
  category: string;
  roofType: string;
  defaultSunroof: boolean;
  cd: string;
  wheelbaseMm: number;
  lengthMm: number;
  highlight: string;
}

export const EGMP_MODELS: Record<EgmpModel, ModelSpec> = {
  ioniq5: {
    id: 'ioniq5',
    name: 'Ioniq 5',
    brand: 'Hyundai',
    badge: 'Retro-Modern CUV',
    category: 'Geometric Crossover',
    roofType: 'Panoramic Vision Roof',
    defaultSunroof: true, // Limited / Ultimate
    cd: '0.288',
    wheelbaseMm: 3000,
    lengthMm: 4635,
    highlight: 'Clamshell hood, 45° Z-crease & Parametric Pixels'
  },
  ev6: {
    id: 'ev6',
    name: 'EV6',
    brand: 'Kia',
    badge: 'Athletic Crossover Coupe',
    category: 'Performance Crossover',
    roofType: 'Power Tilt & Slide Sunroof',
    defaultSunroof: true, // GT-Line / GT
    cd: '0.28',
    wheelbaseMm: 2900,
    lengthMm: 4680,
    highlight: 'Digital Tiger Face, Sweeping Taillight Blade & Double-Wing Spoiler'
  },
  ioniq6: {
    id: 'ioniq6',
    name: 'Ioniq 6',
    brand: 'Hyundai',
    badge: 'Electrified Streamliner',
    category: 'Aerodynamic Sedan',
    roofType: 'Curved Power Sunroof',
    defaultSunroof: true, // Limited / Ultimate
    cd: '0.21',
    wheelbaseMm: 2950,
    lengthMm: 4855,
    highlight: 'Teardrop streamliner body & dual elliptical whale-tail spoilers'
  },
  gv60: {
    id: 'gv60',
    name: 'GV60',
    brand: 'Genesis',
    badge: 'Athletic Luxury Coupe',
    category: 'Luxury Performance EV',
    roofType: 'Genesis Vision Glass Roof',
    defaultSunroof: true, // Performance / Advanced
    cd: '0.29',
    wheelbaseMm: 2900,
    lengthMm: 4515,
    highlight: 'Two-Line Quad Lamps, Clamshell Hood & Volt D-Pillar'
  }
};

export interface VehicleOutlineProps {
  model: EgmpModel;
  sunroof: SunroofConfig;
  onToggleSunroof?: () => void;
  onCycleSunroofState?: () => void;
  onToggleSunshade?: () => void;
  doors: {
    frontLeft: boolean;
    frontRight: boolean;
    rearLeft: boolean;
    rearRight: boolean;
  };
  hoodOpen: boolean;
  trunkOpen: boolean;
  chargePortOpen: boolean;
  isCharging?: boolean;
  mirrorsFolded: boolean;
  lights: 'off' | 'parking' | 'low' | 'high' | 'auto';
  rearDefrost: boolean;
  hazards: boolean;
  turnSignal: 'off' | 'left' | 'right';
  blinkState: boolean;
  gear: 'P' | 'R' | 'N' | 'D';
  speedMph: number;
  perspective: 'exterior' | 'interior' | 'powertrain';
  driverSeat: string;
  passengerSeat: string;
  steeringWheelHeat: string;
  onToggleDoor: (door: 'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight') => void;
  onToggleHood: () => void;
  onToggleTrunk: () => void;
  onToggleChargePort: () => void;
  onCycleDriverSeat: () => void;
  onCyclePassengerSeat: () => void;
  onCycleSteeringHeat: () => void;
}

export const VehicleSilhouette: React.FC<VehicleOutlineProps> = ({
  model,
  sunroof,
  onToggleSunroof,
  onCycleSunroofState,
  onToggleSunshade,
  doors,
  hoodOpen,
  trunkOpen,
  chargePortOpen,
  isCharging,
  mirrorsFolded,
  lights,
  rearDefrost,
  hazards,
  turnSignal,
  blinkState,
  gear,
  speedMph,
  perspective,
  driverSeat,
  passengerSeat,
  steeringWheelHeat,
  onToggleDoor,
  onToggleHood,
  onToggleTrunk,
  onToggleChargePort,
  onCycleDriverSeat,
  onCyclePassengerSeat,
  onCycleSteeringHeat
}) => {
  const isLightsActive = lights !== 'off';
  const chargingActive = Boolean(isCharging || chargePortOpen);

  return (
    <svg
      viewBox="0 0 380 720"
      className="w-full max-w-[340px] sm:max-w-[370px] h-auto drop-shadow-2xl transition-all duration-300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Exterior Body Gradients */}
        <linearGradient id="bodyGradIoniq5" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="50%" stopColor="#172030" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>

        <linearGradient id="bodyGradEV6" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1c2536" />
          <stop offset="50%" stopColor="#151e2d" />
          <stop offset="100%" stopColor="#0d1422" />
        </linearGradient>

        <linearGradient id="bodyGradIoniq6" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e283a" />
          <stop offset="50%" stopColor="#141c2b" />
          <stop offset="100%" stopColor="#0d131f" />
        </linearGradient>

        <linearGradient id="bodyGradGV60" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#242b38" />
          <stop offset="50%" stopColor="#19212d" />
          <stop offset="100%" stopColor="#101620" />
        </linearGradient>

        {/* Glass Tint Gradients */}
        <linearGradient id="glassTint" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#0b1320" stopOpacity="0.95" />
          <stop offset="50%" stopColor="#070c14" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#04070c" stopOpacity="0.95" />
        </linearGradient>

        <linearGradient id="sunroofGlass" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#081426" stopOpacity="0.92" />
          <stop offset="60%" stopColor="#040b17" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#02050a" stopOpacity="0.98" />
        </linearGradient>

        {/* Solid Metal Roof Texture */}
        <linearGradient id="solidRoofGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#243042" />
          <stop offset="50%" stopColor="#1c2635" />
          <stop offset="100%" stopColor="#131b26" />
        </linearGradient>

        {/* Genesis Two-Line Glow Filter */}
        <filter id="twoLineGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>

        {/* Carbon / Aero Texture Pattern */}
        <pattern id="pixelGridPattern" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="2" height="2" fill="#38bdf8" fillOpacity="0.8" />
          <rect x="2" y="2" width="2" height="2" fill="#0284c7" fillOpacity="0.6" />
        </pattern>

        {/* EV Charging Soft Aura Glow Filter */}
        <filter id="chargingAuraGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>

        <style>
          {`
            @keyframes charge-dots-flow-inward {
              0% {
                stroke-dashoffset: 54;
              }
              100% {
                stroke-dashoffset: 0;
              }
            }
            @keyframes charge-pulse-slow {
              0%, 100% {
                opacity: 0.4;
                transform: scale(0.96);
              }
              50% {
                opacity: 0.95;
                transform: scale(1.04);
              }
            }
            @keyframes charge-port-pulse-slow {
              0% {
                r: 6px;
                opacity: 0.9;
              }
              100% {
                r: 16px;
                opacity: 0;
              }
            }
            .charge-dot-stream {
              stroke-dasharray: 4 14;
              animation: charge-dots-flow-inward 10.5s linear infinite !important;
            }
            .charge-port-ripple {
              animation: charge-port-pulse-slow 2.8s ease-out infinite !important;
            }
          `}
        </style>
      </defs>

      {/* 1. Ground Shadow (Matched to vehicle footprint) */}
      <ellipse
        cx="190"
        cy="360"
        rx={model === 'ev6' ? 142 : model === 'ioniq6' ? 134 : 140}
        ry={model === 'ioniq6' ? 315 : 300}
        fill="rgba(0,0,0,0.55)"
        filter="blur(26px)"
      />

      {/* 2. 4 Wheels / Tires with Brake Calipers & Alloy Finish */}
      {/* Front Left */}
      <g id="wheel-fl">
        <rect x="52" y="140" width="28" height="66" rx="8" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
        <rect x="58" y="152" width="16" height="42" rx="4" fill="#334155" />
        <rect x="72" y="160" width="6" height="24" rx="2" fill={model === 'ev6' ? '#84cc16' : model === 'gv60' ? '#eab308' : '#0284c7'} />
      </g>
      {/* Front Right */}
      <g id="wheel-fr">
        <rect x="300" y="140" width="28" height="66" rx="8" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
        <rect x="306" y="152" width="16" height="42" rx="4" fill="#334155" />
        <rect x="302" y="160" width="6" height="24" rx="2" fill={model === 'ev6' ? '#84cc16' : model === 'gv60' ? '#eab308' : '#0284c7'} />
      </g>
      {/* Rear Left */}
      <g id="wheel-rl">
        <rect x="52" y="510" width="28" height="66" rx="8" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
        <rect x="58" y="522" width="16" height="42" rx="4" fill="#334155" />
        <rect x="72" y="530" width="6" height="24" rx="2" fill={model === 'ev6' ? '#84cc16' : model === 'gv60' ? '#eab308' : '#0284c7'} />
      </g>
      {/* Rear Right */}
      <g id="wheel-rr">
        <rect x="300" y="510" width="28" height="66" rx="8" fill="#1e293b" stroke="#0f172a" strokeWidth="2" />
        <rect x="306" y="522" width="16" height="42" rx="4" fill="#334155" />
        <rect x="302" y="530" width="6" height="24" rx="2" fill={model === 'ev6' ? '#84cc16' : model === 'gv60' ? '#eab308' : '#0284c7'} />
      </g>

      {/* 3. Model-Specific Body Shell Outline */}
      {model === 'ioniq5' && (
        <g id="shell-ioniq5">
          {/* Main Geometric Crossover Body Shell */}
          <path
            d="M 124 50 C 150 44, 230 44, 256 50 C 278 56, 296 82, 302 125 C 308 190, 308 260, 304 360 C 302 460, 308 535, 302 595 C 296 638, 278 666, 254 672 C 220 680, 160 680, 126 672 C 102 666, 84 638, 78 595 C 72 535, 78 460, 76 360 C 72 260, 72 190, 78 125 C 84 82, 102 56, 124 50 Z"
            fill="url(#bodyGradIoniq5)"
            stroke="#334155"
            strokeWidth="2.5"
          />
          {/* Iconic 45° Diagonal Z-Crease across Door Panels */}
          <path d="M 88 230 L 104 360 L 88 470" stroke="#475569" strokeWidth="1.5" fill="none" opacity="0.75" />
          <path d="M 292 230 L 276 360 L 292 470" stroke="#475569" strokeWidth="1.5" fill="none" opacity="0.75" />
          {/* Wheel Arch Strakes (Radial Geometric Arch Cladding) */}
          <path d="M 76 138 Q 98 125, 104 172 Q 98 215, 76 208" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.4" />
          <path d="M 304 138 Q 282 125, 276 172 Q 282 215, 304 208" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.4" />
          <path d="M 76 508 Q 98 495, 104 542 Q 98 585, 76 578" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.4" />
          <path d="M 304 508 Q 282 495, 276 542 Q 282 585, 304 578" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.4" />
        </g>
      )}

      {model === 'ev6' && (
        <g id="shell-ev6">
          {/* Athletic Crossover Coupe Shell with Pinched Waist and Muscular Haunches */}
          <path
            d="M 132 46 C 160 40, 220 40, 248 46 C 272 52, 288 78, 296 122 C 302 180, 298 250, 292 340 C 288 420, 304 490, 308 550 C 310 605, 298 644, 264 666 C 230 678, 150 678, 116 666 C 82 644, 70 605, 72 550 C 76 490, 92 420, 88 340 C 82 250, 78 180, 84 122 C 92 78, 108 52, 132 46 Z"
            fill="url(#bodyGradEV6)"
            stroke="#334155"
            strokeWidth="2.5"
          />
          {/* Upward-Sweeping Rocker Character Line slicing toward rear lights */}
          <path d="M 86 320 C 88 420, 80 500, 72 550" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="6 3" fill="none" opacity="0.6" />
          <path d="M 294 320 C 292 420, 300 500, 308 550" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="6 3" fill="none" opacity="0.6" />
          {/* Muscular Front Fender Ridges */}
          <path d="M 98 120 C 104 150, 106 185, 100 210" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.5" />
          <path d="M 282 120 C 276 150, 274 185, 280 210" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.5" />
        </g>
      )}

      {model === 'ioniq6' && (
        <g id="shell-ioniq6">
          {/* Streamliner Teardrop Silhouette with continuous curve to boat-tail */}
          <path
            d="M 138 46 C 168 40, 212 40, 242 46 C 268 52, 286 78, 292 128 C 298 195, 296 275, 294 360 C 292 445, 288 515, 276 585 C 264 640, 242 676, 190 682 C 138 676, 116 640, 104 585 C 92 515, 88 445, 86 360 C 84 275, 82 195, 88 128 C 94 78, 112 52, 138 46 Z"
            fill="url(#bodyGradIoniq6)"
            stroke="#334155"
            strokeWidth="2.5"
          />
          {/* Streamliner Single-Arc Aerodynamic Boundary Contour */}
          <path d="M 98 140 C 92 260, 92 440, 110 560" stroke="#38bdf8" strokeWidth="1" fill="none" opacity="0.4" />
          <path d="M 282 140 C 288 260, 288 440, 270 560" stroke="#38bdf8" strokeWidth="1" fill="none" opacity="0.4" />
        </g>
      )}

      {model === 'gv60' && (
        <g id="shell-gv60">
          {/* Genesis Athletic Luxury Coupe Crossover Shell */}
          <path
            d="M 130 48 C 160 42, 220 42, 250 48 C 274 54, 292 82, 298 126 C 304 185, 302 260, 300 355 C 298 450, 306 525, 302 590 C 296 636, 276 666, 250 672 C 216 678, 164 678, 130 672 C 104 666, 84 636, 78 590 C 74 525, 82 450, 80 355 C 78 260, 76 185, 82 126 C 88 82, 106 54, 130 48 Z"
            fill="url(#bodyGradGV60)"
            stroke="#334155"
            strokeWidth="2.5"
          />
          {/* Signature Genesis "Volt D-Pillar" Chrome Zigzag Garnish */}
          <path d="M 94 455 L 86 492 L 96 524" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M 286 455 L 294 492 L 284 524" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {/* Smooth Muscular Rear Shoulder Lines */}
          <path d="M 94 360 C 88 460, 84 520, 80 570" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.6" />
          <path d="M 286 360 C 292 460, 296 520, 300 570" stroke="#475569" strokeWidth="1.2" fill="none" opacity="0.6" />
        </g>
      )}

      {/* 4. Front Hood / Frunk Panel (Adapted to each model) */}
      <g id="hood-panel">
        {model === 'ioniq5' && (
          <path
            d="M 120 58 C 155 52, 225 52, 260 58 C 274 95, 276 138, 272 172 L 108 172 C 104 138, 106 95, 120 58 Z"
            fill={hoodOpen ? '#1e293b' : '#1b232e'}
            stroke={hoodOpen ? '#f59e0b' : '#334155'}
            strokeWidth={hoodOpen ? '2' : '1.2'}
            strokeDasharray={hoodOpen ? '4 2' : 'none'}
            className="cursor-pointer transition-all hover:opacity-85"
            onClick={onToggleHood}
          />
        )}
        {model === 'ev6' && (
          <path
            d="M 130 52 C 160 46, 220 46, 250 52 C 268 88, 270 134, 266 170 L 114 170 C 110 134, 112 88, 130 52 Z"
            fill={hoodOpen ? '#1e293b' : '#1a222c'}
            stroke={hoodOpen ? '#f59e0b' : '#334155'}
            strokeWidth={hoodOpen ? '2' : '1.2'}
            strokeDasharray={hoodOpen ? '4 2' : 'none'}
            className="cursor-pointer transition-all hover:opacity-85"
            onClick={onToggleHood}
          />
        )}
        {model === 'ioniq6' && (
          <path
            d="M 134 52 C 165 46, 215 46, 246 52 C 264 88, 266 135, 262 172 L 118 172 C 114 135, 116 88, 134 52 Z"
            fill={hoodOpen ? '#1e293b' : '#18202a'}
            stroke={hoodOpen ? '#f59e0b' : '#334155'}
            strokeWidth={hoodOpen ? '2' : '1.2'}
            strokeDasharray={hoodOpen ? '4 2' : 'none'}
            className="cursor-pointer transition-all hover:opacity-85"
            onClick={onToggleHood}
          />
        )}
        {model === 'gv60' && (
          <path
            d="M 124 54 C 158 48, 222 48, 256 54 C 272 90, 274 135, 270 172 L 110 172 C 106 135, 108 90, 124 54 Z"
            fill={hoodOpen ? '#1e293b' : '#1c2430'}
            stroke={hoodOpen ? '#f59e0b' : '#334155'}
            strokeWidth={hoodOpen ? '2' : '1.2'}
            strokeDasharray={hoodOpen ? '4 2' : 'none'}
            className="cursor-pointer transition-all hover:opacity-85"
            onClick={onToggleHood}
          />
        )}

        {/* Model Hood Badges */}
        {model === 'gv60' && !hoodOpen && (
          <g id="genesis-wings" opacity="0.8">
            <ellipse cx="190" cy="80" rx="8" ry="4" fill="#94a3b8" />
            <line x1="168" y1="80" x2="182" y2="80" stroke="#94a3b8" strokeWidth="1.5" />
            <line x1="198" y1="80" x2="212" y2="80" stroke="#94a3b8" strokeWidth="1.5" />
          </g>
        )}
        {model === 'ev6' && !hoodOpen && (
          <text x="190" y="82" textAnchor="middle" fill="#94a3b8" fontSize="8" fontWeight="bold" fontFamily="sans-serif" letterSpacing="2">
            KIA
          </text>
        )}
        {hoodOpen && (
          <text x="190" y="125" textAnchor="middle" fill="#f59e0b" fontSize="11" fontWeight="bold" fontFamily="monospace">
            FRUNK AJAR
          </text>
        )}
      </g>

      {/* 5. Windshield Glass */}
      <path
        d="M 110 176 L 270 176 C 264 216, 256 246, 250 262 L 130 262 C 124 246, 116 216, 110 176 Z"
        fill="url(#glassTint)"
        stroke="#1e293b"
        strokeWidth="1.5"
      />
      {/* Windshield Wipers */}
      <line x1="135" y1="182" x2="190" y2="186" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="200" y1="184" x2="255" y2="188" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" />

      {/* 6. Roof Section: Dynamic Outlines for Sunroof vs Solid Roof */}
      <g id="roof-module" className="cursor-pointer" onClick={onToggleSunroof}>
        {/* Case A: Has Sunroof (Vision Roof / Tilt & Slide Glass) */}
        {sunroof.equipped ? (
          <g id="sunroof-equipped">
            {/* Outer Glass Perimeter Aperture */}
            {model === 'ioniq5' && (
              // Hyundai Ioniq 5: Expansive Panoramic Vision Roof
              <g id="ioniq5-vision-roof">
                <rect
                  x="122"
                  y="266"
                  width="136"
                  height="214"
                  rx="16"
                  fill={sunroof.sunshade === 'open' ? 'url(#sunroofGlass)' : '#1e2837'}
                  stroke="#0284c7"
                  strokeWidth="1.5"
                />
                {/* Sunshade roller seam or glass tint reflections */}
                {sunroof.sunshade === 'open' ? (
                  <>
                    <line x1="126" y1="373" x2="254" y2="373" stroke="#0284c7" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                    {/* Solar Glass Sheen Diagonal */}
                    <line x1="136" y1="280" x2="242" y2="460" stroke="#38bdf8" strokeWidth="1" opacity="0.25" />
                    <text x="190" y="380" textAnchor="middle" fill="#38bdf8" fontSize="9" fontWeight="bold" fontFamily="monospace" opacity="0.9">
                      VISION ROOF
                    </text>
                  </>
                ) : (
                  <>
                    {/* Power Fabric Shade Closed */}
                    <line x1="126" y1="373" x2="254" y2="373" stroke="#475569" strokeWidth="2" />
                    <text x="190" y="380" textAnchor="middle" fill="#94a3b8" fontSize="8" fontWeight="bold" fontFamily="monospace">
                      SHADE CLOSED
                    </text>
                  </>
                )}
              </g>
            )}

            {model === 'ev6' && (
              // Kia EV6: Power Tilt & Slide Sunroof
              <g id="ev6-power-sunroof">
                {/* Solid rear roof area */}
                <rect x="126" y="375" width="128" height="105" rx="10" fill="url(#solidRoofGrad)" stroke="#334155" strokeWidth="1" />
                {/* Power Sunroof Aperture with dark surround frame */}
                <rect
                  x="130"
                  y="268"
                  width="120"
                  height="102"
                  rx="12"
                  fill={sunroof.state === 'open' ? '#030712' : 'url(#sunroofGlass)'}
                  stroke={sunroof.state !== 'closed' ? '#38bdf8' : '#334155'}
                  strokeWidth={sunroof.state !== 'closed' ? '2' : '1.5'}
                />
                {/* Pop-up Wind Deflector at front lip */}
                <rect x="134" y="270" width="112" height="4" rx="1" fill="#475569" />
                {sunroof.state === 'vent' && (
                  <g>
                    <rect x="134" y="356" width="112" height="10" rx="3" fill="#38bdf8" fillOpacity="0.3" stroke="#38bdf8" strokeWidth="1" />
                    <text x="190" y="364" textAnchor="middle" fill="#38bdf8" fontSize="8" fontWeight="bold" fontFamily="monospace">
                      TILT VENT
                    </text>
                  </g>
                )}
                {sunroof.state === 'open' && (
                  <g>
                    {/* Slide back glass panel overlapping rear roof */}
                    <rect x="132" y="340" width="116" height="50" rx="6" fill="#0c131f" stroke="#0284c7" strokeWidth="1.5" opacity="0.9" />
                    <text x="190" y="320" textAnchor="middle" fill="#38bdf8" fontSize="9" fontWeight="bold" fontFamily="monospace">
                      SUNROOF OPEN
                    </text>
                  </g>
                )}
                {sunroof.state === 'closed' && (
                  <text x="190" y="326" textAnchor="middle" fill="#64748b" fontSize="8" fontWeight="medium" fontFamily="monospace">
                    GLASS SUNROOF
                  </text>
                )}
              </g>
            )}

            {model === 'ioniq6' && (
              // Hyundai Ioniq 6: Curved Power Sunroof on Streamliner Canopy
              <g id="ioniq6-power-sunroof">
                <rect x="130" y="370" width="120" height="110" rx="8" fill="url(#solidRoofGrad)" stroke="#334155" strokeWidth="1" />
                <rect
                  x="132"
                  y="266"
                  width="116"
                  height="100"
                  rx="10"
                  fill={sunroof.state === 'open' ? '#030712' : 'url(#sunroofGlass)'}
                  stroke={sunroof.state !== 'closed' ? '#38bdf8' : '#334155'}
                  strokeWidth="1.5"
                />
                {sunroof.state === 'vent' && (
                  <rect x="136" y="354" width="108" height="8" rx="2" fill="#38bdf8" fillOpacity="0.35" stroke="#38bdf8" strokeWidth="1" />
                )}
                {sunroof.state === 'open' && (
                  <rect x="134" y="338" width="112" height="48" rx="6" fill="#0c131f" stroke="#38bdf8" strokeWidth="1.5" opacity="0.9" />
                )}
                <text x="190" y="322" textAnchor="middle" fill="#38bdf8" fontSize="8" fontWeight="bold" fontFamily="monospace">
                  {sunroof.state === 'open' ? 'SUNROOF OPEN' : sunroof.state === 'vent' ? 'TILT VENT' : 'GLASS SUNROOF'}
                </text>
              </g>
            )}

            {model === 'gv60' && (
              // Genesis GV60: Seamless Edge-to-Edge Vision Glass Roof
              <g id="gv60-vision-roof">
                <rect
                  x="122"
                  y="264"
                  width="136"
                  height="216"
                  rx="16"
                  fill={sunroof.sunshade === 'open' ? 'url(#sunroofGlass)' : '#1e2837'}
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                />
                {sunroof.sunshade === 'open' ? (
                  <>
                    <line x1="126" y1="372" x2="254" y2="372" stroke="#38bdf8" strokeWidth="1" strokeDasharray="4 2" opacity="0.6" />
                    <text x="190" y="378" textAnchor="middle" fill="#e0f2fe" fontSize="9" fontWeight="bold" fontFamily="monospace">
                      GENESIS VISION ROOF
                    </text>
                  </>
                ) : (
                  <text x="190" y="378" textAnchor="middle" fill="#94a3b8" fontSize="8" fontWeight="bold" fontFamily="monospace">
                    POWER BLIND CLOSED
                  </text>
                )}
              </g>
            )}
          </g>
        ) : (
          /* Case B: Solid Metal Roof (No Sunroof) */
          <g id="solid-roof-equipped">
            <rect
              x="124"
              y="266"
              width="132"
              height="214"
              rx="16"
              fill="url(#solidRoofGrad)"
              stroke="#334155"
              strokeWidth="1.5"
            />
            {/* Model-specific solid roof channels */}
            {model === 'ioniq5' && (
              // Ioniq 5: Dual longitudinal acoustic roof channels
              <>
                <line x1="150" y1="272" x2="150" y2="472" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="230" y1="272" x2="230" y2="472" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" />
              </>
            )}
            {model === 'ev6' && (
              // EV6: Double-bubble aerodynamic roof stamping with center groove
              <>
                <line x1="190" y1="272" x2="190" y2="472" stroke="#334155" strokeWidth="2" strokeDasharray="8 4" />
                {/* Roof Rails */}
                <line x1="130" y1="280" x2="130" y2="460" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" />
                <line x1="250" y1="280" x2="250" y2="460" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" />
              </>
            )}
            {model === 'ioniq6' && (
              // Ioniq 6: Continuous slick aerodynamic roof stamping
              <>
                <line x1="165" y1="280" x2="165" y2="460" stroke="#334155" strokeWidth="1" opacity="0.4" />
                <line x1="215" y1="280" x2="215" y2="460" stroke="#334155" strokeWidth="1" opacity="0.4" />
              </>
            )}
            {model === 'gv60' && (
              // GV60: Clean minimalist luxury roof
              <ellipse cx="190" cy="373" rx="40" ry="60" fill="#1e293b" opacity="0.3" />
            )}
            <text x="190" y="378" textAnchor="middle" fill="#64748b" fontSize="9" fontWeight="medium" fontFamily="monospace">
              SOLID STEEL ROOF
            </text>
          </g>
        )}
      </g>

      {/* 7. Rear Window Glass */}
      <path
        d="M 128 484 L 252 484 C 258 500, 264 526, 268 548 L 112 548 C 116 526, 122 500, 128 484 Z"
        fill="url(#glassTint)"
        stroke="#1e293b"
        strokeWidth="1.5"
      />
      {/* Rear Defogger Heating Lines */}
      {rearDefrost && (
        <g opacity="0.8">
          <line x1="132" y1="496" x2="248" y2="496" stroke="#ef4444" strokeWidth="1" />
          <line x1="126" y1="510" x2="254" y2="510" stroke="#ef4444" strokeWidth="1" />
          <line x1="120" y1="524" x2="260" y2="524" stroke="#ef4444" strokeWidth="1" />
          <line x1="116" y1="538" x2="264" y2="538" stroke="#ef4444" strokeWidth="1" />
        </g>
      )}

      {/* 8. Spoilers & Aerodynamic Wings */}
      {model === 'ioniq5' && (
        // Ioniq 5: Dual-vent aero roof spoiler
        <g id="spoiler-ioniq5">
          <path d="M 112 546 L 268 546 C 270 568, 264 582, 256 590 L 124 590 C 116 582, 110 568, 112 546 Z" fill="#1e293b" stroke="#334155" strokeWidth="1.2" />
          {/* Twin Passthrough Vents */}
          <rect x="146" y="556" width="26" height="18" rx="4" fill="#090d14" stroke="#334155" strokeWidth="1" />
          <rect x="208" y="556" width="26" height="18" rx="4" fill="#090d14" stroke="#334155" strokeWidth="1" />
        </g>
      )}

      {model === 'ev6' && (
        // EV6: Double-wing roof spoiler with twin air vents & high ducktail
        <g id="spoiler-ev6">
          <path d="M 116 528 C 145 538, 235 538, 264 528 C 270 550, 262 566, 254 572 L 126 572 C 118 566, 110 550, 116 528 Z" fill="#1e293b" stroke="#334155" strokeWidth="1.2" />
          <rect x="142" y="538" width="28" height="16" rx="4" fill="#090d14" />
          <rect x="210" y="538" width="28" height="16" rx="4" fill="#090d14" />
        </g>
      )}

      {model === 'ioniq6' && (
        // Ioniq 6: Dual Elliptical Whale-Tail Spoiler
        <g id="spoiler-ioniq6">
          <path
            d="M 124 550 C 150 538, 230 538, 256 550 C 262 568, 252 584, 190 588 C 128 584, 118 568, 124 550 Z"
            fill="#1e293b"
            stroke="#0284c7"
            strokeWidth="1.5"
          />
          {/* Illuminated translucent parametric pixel third brake light winglet */}
          <rect x="150" y="558" width="80" height="8" rx="3" fill="#ef4444" stroke="#f87171" strokeWidth="1" opacity={gear === 'P' || speedMph === 0 ? 1 : 0.6} />
        </g>
      )}

      {model === 'gv60' && (
        // GV60: Fixed aerofoil coupe rear wing
        <g id="spoiler-gv60">
          <path
            d="M 118 558 L 262 558 C 266 574, 258 586, 248 590 L 132 590 C 122 586, 114 574, 118 558 Z"
            fill="#1e293b"
            stroke="#334155"
            strokeWidth="1.2"
          />
          <rect x="160" y="566" width="60" height="4" rx="1.5" fill="#ef4444" />
        </g>
      )}

      {/* 9. Rear Trunk / Liftgate Panel */}
      <path
        d="M 112 588 L 268 588 C 264 624, 256 652, 246 664 L 134 664 C 124 652, 116 624, 112 588 Z"
        fill={trunkOpen ? '#1e293b' : '#171f2b'}
        stroke={trunkOpen ? '#f59e0b' : '#334155'}
        strokeWidth={trunkOpen ? '2' : '1.2'}
        strokeDasharray={trunkOpen ? '4 2' : 'none'}
        className="cursor-pointer transition-all hover:opacity-85"
        onClick={onToggleTrunk}
      />
      {trunkOpen && (
        <text x="190" y="626" textAnchor="middle" fill="#f59e0b" fontSize="11" fontWeight="bold" fontFamily="monospace">
          TRUNK OPEN
        </text>
      )}

      {/* 10. 4 Doors with Physical Swing-Out on Hinge */}
      {/* Front Left (Driver) Door */}
      <g
        id="door-fl"
        className="cursor-pointer"
        onClick={() => onToggleDoor('frontLeft')}
        transform={doors.frontLeft ? 'translate(-50, 2) rotate(24 84 310)' : 'none'}
        style={{ transition: 'transform 0.3s ease-out' }}
      >
        <path d="M 84 195 C 80 230, 80 270, 82 310 L 98 310 L 98 195 Z" fill={doors.frontLeft ? '#b45309' : '#1e293b'} stroke={doors.frontLeft ? '#f59e0b' : '#475569'} strokeWidth="1.5" />
        <rect x="88" y="295" width="4" height="12" rx="1.5" fill="#94a3b8" />
      </g>
      {/* Front Right (Passenger) Door */}
      <g
        id="door-fr"
        className="cursor-pointer"
        onClick={() => onToggleDoor('frontRight')}
        transform={doors.frontRight ? 'translate(14, 2) rotate(-14 296 310)' : 'none'}
        style={{ transition: 'transform 0.3s ease-out' }}
      >
        <path d="M 296 195 C 300 230, 300 270, 298 310 L 282 310 L 282 195 Z" fill={doors.frontRight ? '#b45309' : '#1e293b'} stroke={doors.frontRight ? '#f59e0b' : '#475569'} strokeWidth="1.5" />
        <rect x="288" y="295" width="4" height="12" rx="1.5" fill="#94a3b8" />
      </g>
      {/* Rear Left Door */}
      <g
        id="door-rl"
        className="cursor-pointer"
        onClick={() => onToggleDoor('rearLeft')}
        transform={doors.rearLeft ? 'translate(-14, -2) rotate(-14 82 320)' : 'none'}
        style={{ transition: 'transform 0.3s ease-out' }}
      >
        <path d="M 82 320 C 80 360, 80 400, 84 445 L 98 445 L 98 320 Z" fill={doors.rearLeft ? '#b45309' : '#1e293b'} stroke={doors.rearLeft ? '#f59e0b' : '#475569'} strokeWidth="1.5" />
        <rect x="88" y="332" width="4" height="12" rx="1.5" fill="#94a3b8" />
      </g>
      {/* Rear Right Door */}
      <g
        id="door-rr"
        className="cursor-pointer"
        onClick={() => onToggleDoor('rearRight')}
        transform={doors.rearRight ? 'translate(14, -2) rotate(14 298 320)' : 'none'}
        style={{ transition: 'transform 0.3s ease-out' }}
      >
        <path d="M 298 320 C 300 360, 300 400, 296 445 L 282 445 L 282 320 Z" fill={doors.rearRight ? '#b45309' : '#1e293b'} stroke={doors.rearRight ? '#f59e0b' : '#475569'} strokeWidth="1.5" />
        <rect x="288" y="332" width="4" height="12" rx="1.5" fill="#94a3b8" />
      </g>

      {/* 11. Charge Port Door (Rear Right Quarter Panel) */}
      <g id="charge-port" className="cursor-pointer" onClick={onToggleChargePort}>
        <rect
          x="292"
          y="500"
          width="9"
          height="20"
          rx="2"
          fill={chargingActive ? '#10b981' : '#334155'}
          stroke={chargingActive ? '#34d399' : '#475569'}
          strokeWidth="1.5"
        />
        {chargingActive && (
          <>
            <circle cx="296" cy="510" r="5" fill="#10b981" opacity="0.9" />
            <circle
              cx="296"
              cy="510"
              r="6"
              fill="none"
              stroke="#34d399"
              strokeWidth="1.5"
              className="charge-port-ripple"
            />
          </>
        )}
      </g>

      {/* 11b. EV High-Voltage Charging Energy Flow (Slow Inward Green Dots) */}
      {chargingActive && (
        <g id="charging-energy-flow" className="pointer-events-none">
          {/* Subtle Ambient Charging Aura along Conduit Track */}
          <path
            d="M 296 510 C 270 510, 240 485, 218 455 C 200 428, 190 395, 190 340"
            stroke="#10b981"
            strokeWidth="10"
            strokeLinecap="round"
            fill="none"
            opacity="0.18"
            filter="url(#chargingAuraGlow)"
          />

          {/* High Voltage Charging Conduit Base Guide Line */}
          <path
            d="M 296 510 C 270 510, 240 485, 218 455 C 200 428, 190 395, 190 340"
            stroke="#065f46"
            strokeWidth="2.5"
            strokeLinecap="round"
            fill="none"
            opacity="0.65"
          />

          {/* Animated Green Dots Flowing Inward into the Battery Pack (Slow Speed) */}
          <path
            d="M 296 510 C 270 510, 240 485, 218 455 C 200 428, 190 395, 190 340"
            stroke="#34d399"
            strokeWidth="4.5"
            strokeLinecap="round"
            fill="none"
            className="charge-dot-stream"
          />

          {/* Central Battery Pack Spine Distribution Track */}
          <path
            d="M 190 340 L 190 260"
            stroke="#34d399"
            strokeWidth="3.5"
            strokeLinecap="round"
            fill="none"
            className="charge-dot-stream"
          />

          {/* Soft Pulsing Energy Beacon at Battery Core */}
          <circle
            cx="190"
            cy="340"
            r="6"
            fill="#10b981"
            style={{ animation: 'charge-pulse-slow 2.6s ease-in-out infinite' }}
          />
          <circle
            cx="190"
            cy="340"
            r="13"
            fill="none"
            stroke="#34d399"
            strokeWidth="1.5"
            opacity="0.5"
            style={{ animation: 'charge-pulse-slow 2.6s ease-in-out infinite' }}
          />
        </g>
      )}

      {/* 12. Side Mirrors */}
      <g id="mirrors" transform={mirrorsFolded ? 'scale(0.85 1)' : 'none'} style={{ transition: 'transform 0.3s' }}>
        <path d="M 84 175 L 56 160 C 52 165, 54 185, 62 188 L 84 182 Z" fill="#1e293b" stroke="#334155" strokeWidth="1.5" />
        <path d="M 296 175 L 324 160 C 328 165, 326 185, 318 188 L 296 182 Z" fill="#1e293b" stroke="#334155" strokeWidth="1.5" />
      </g>

      {/* 13. Front Headlights / Lighting Signatures */}
      {model === 'ioniq5' && (
        // Ioniq 5: Dual Rectangular Parametric Pixel LED Clusters
        <g id="lights-ioniq5">
          {/* Left Cluster */}
          <rect x="104" y="62" width="16" height="18" rx="2" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          <rect x="124" y="60" width="16" height="18" rx="2" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          {/* Right Cluster */}
          <rect x="240" y="60" width="16" height="18" rx="2" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          <rect x="260" y="62" width="16" height="18" rx="2" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          {/* Center Pixel Lightbar Band */}
          <line x1="142" y1="68" x2="238" y2="68" stroke={isLightsActive ? '#bae6fd' : '#334155'} strokeWidth="2.5" strokeLinecap="round" />
        </g>
      )}

      {model === 'ev6' && (
        // EV6: Digital Tiger Face Sharp Triangular Arrow DRLs
        <g id="lights-ev6">
          {/* Left Arrow Headlight */}
          <path d="M 98 72 L 140 60 L 138 74 L 108 82 Z" fill={isLightsActive ? '#bae6fd' : '#1e293b'} stroke="#38bdf8" strokeWidth="1.5" />
          {/* Right Arrow Headlight */}
          <path d="M 282 72 L 240 60 L 242 74 L 272 82 Z" fill={isLightsActive ? '#bae6fd' : '#1e293b'} stroke="#38bdf8" strokeWidth="1.5" />
          {/* Lower Dynamic Air Flap accent */}
          <line x1="142" y1="62" x2="238" y2="62" stroke={isLightsActive ? '#e0f2fe' : '#334155'} strokeWidth="1.5" />
        </g>
      )}

      {model === 'ioniq6' && (
        // Ioniq 6: Streamliner Parametric Pixel Matrix Projectors
        <g id="lights-ioniq6">
          <rect x="106" y="62" width="32" height="14" rx="3" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          <rect x="242" y="62" width="32" height="14" rx="3" fill={isLightsActive ? '#38bdf8' : '#1e293b'} stroke="#0284c7" strokeWidth="1" />
          <line x1="140" y1="68" x2="240" y2="68" stroke={isLightsActive ? '#7dd3fc' : '#334155'} strokeWidth="2" strokeDasharray="3 2" />
        </g>
      )}

      {model === 'gv60' && (
        // Genesis: World-Famous Signature TWO-LINE QUAD LAMPS
        <g id="lights-gv60" filter="url(#twoLineGlow)">
          {/* Left Dual Lines */}
          <line x1="98" y1="66" x2="140" y2="66" stroke={isLightsActive ? '#e0f2fe' : '#334155'} strokeWidth="3" strokeLinecap="round" />
          <line x1="102" y1="76" x2="142" y2="76" stroke={isLightsActive ? '#e0f2fe' : '#334155'} strokeWidth="3" strokeLinecap="round" />
          {/* Right Dual Lines */}
          <line x1="240" y1="66" x2="282" y2="66" stroke={isLightsActive ? '#e0f2fe' : '#334155'} strokeWidth="3" strokeLinecap="round" />
          <line x1="238" y1="76" x2="278" y2="76" stroke={isLightsActive ? '#e0f2fe' : '#334155'} strokeWidth="3" strokeLinecap="round" />
        </g>
      )}

      {/* 14. Rear Taillight Signatures */}
      {model === 'ioniq5' && (
        // Ioniq 5: Full-Width Parametric Pixel Taillight Bar
        <g id="rear-ioniq5">
          <rect x="108" y="662" width="164" height="7" rx="2" fill="#ef4444" stroke="#b91c1c" strokeWidth="1" />
          {/* Center Pixel Matrix Brake Cluster */}
          <line x1="140" y1="665" x2="240" y2="665" stroke="#fee2e2" strokeWidth="2" strokeDasharray="3 2" />
        </g>
      )}

      {model === 'ev6' && (
        // EV6: Dramatic High-Deck Curved Sweeping Light Blade
        <g id="rear-ev6">
          <path
            d="M 74 570 C 80 622, 115 660, 190 662 C 265 660, 300 622, 306 570"
            stroke="#ef4444"
            strokeWidth="4.5"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 76 572 C 82 622, 115 660, 190 662 C 265 660, 298 622, 304 572"
            stroke="#fca5a5"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      )}

      {model === 'ioniq6' && (
        // Ioniq 6: Streamliner Pixel Rear Strip & Elliptical Wing Third Brake Light
        <g id="rear-ioniq6">
          <rect x="122" y="666" width="136" height="6" rx="2" fill="#ef4444" stroke="#b91c1c" strokeWidth="1" />
          <line x1="140" y1="669" x2="240" y2="669" stroke="#fca5a5" strokeWidth="1.5" strokeDasharray="3 2" />
        </g>
      )}

      {model === 'gv60' && (
        // Genesis: Signature TWO-LINE QUAD TAILLIGHTS
        <g id="rear-gv60" filter="url(#twoLineGlow)">
          <line x1="104" y1="648" x2="148" y2="648" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
          <line x1="108" y1="658" x2="150" y2="658" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
          <line x1="232" y1="648" x2="276" y2="648" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
          <line x1="230" y1="658" x2="272" y2="658" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
        </g>
      )}

      {/* 15. Amber Turn Signals / Hazard Indicators */}
      {(hazards || turnSignal !== 'off') && blinkState && (
        <g id="amber-blinkers">
          {(hazards || turnSignal === 'left') && (
            <>
              <circle cx="98" cy="74" r="8" fill="#f59e0b" opacity="0.95" />
              <circle cx="106" cy="662" r="8" fill="#f59e0b" opacity="0.95" />
            </>
          )}
          {(hazards || turnSignal === 'right') && (
            <>
              <circle cx="282" cy="74" r="8" fill="#f59e0b" opacity="0.95" />
              <circle cx="274" cy="662" r="8" fill="#f59e0b" opacity="0.95" />
            </>
          )}
        </g>
      )}

      {/* 16. Interior Cabin Seating & Comfort (Visible in Interior perspective or when sunroof shade is open) */}
      {(perspective === 'interior' || sunroof.sunshade === 'open') && (
        <g id="cabin-interior" opacity={perspective === 'interior' ? 1 : 0.75}>
          {/* Infotainment Curved Dual Screen Display */}
          <rect x="140" y="235" width="100" height="14" rx="3" fill="#0284c7" opacity="0.85" />
          <line x1="190" y1="235" x2="190" y2="249" stroke="#0f172a" strokeWidth="1" />

          {/* Steering Wheel */}
          <g id="steering-wheel" className="cursor-pointer" onClick={onCycleSteeringHeat}>
            <circle cx="145" cy="225" r="16" stroke={steeringWheelHeat !== 'off' ? '#f59e0b' : '#64748b'} strokeWidth="3" fill="none" />
            <line x1="130" y1="225" x2="160" y2="225" stroke={steeringWheelHeat !== 'off' ? '#f59e0b' : '#64748b'} strokeWidth="2.5" />
            {steeringWheelHeat !== 'off' && (
              <circle cx="145" cy="225" r="8" fill="#f59e0b" opacity="0.4" />
            )}
          </g>

          {/* Driver Seat (FL) */}
          <g id="seat-driver" className="cursor-pointer" onClick={onCycleDriverSeat}>
            <rect
              x="130"
              y="275"
              width="38"
              height="50"
              rx="8"
              fill={
                driverSeat.startsWith('heat')
                  ? '#7f1d1d'
                  : driverSeat.startsWith('cool')
                  ? '#0c4a6e'
                  : '#1e293b'
              }
              stroke={
                driverSeat.startsWith('heat')
                  ? '#ef4444'
                  : driverSeat.startsWith('cool')
                  ? '#38bdf8'
                  : '#334155'
              }
              strokeWidth="1.5"
            />
            <rect x="134" y="328" width="30" height="12" rx="4" fill="#334155" />
          </g>

          {/* Passenger Seat (FR) */}
          <g id="seat-passenger" className="cursor-pointer" onClick={onCyclePassengerSeat}>
            <rect
              x="212"
              y="275"
              width="38"
              height="50"
              rx="8"
              fill={
                passengerSeat.startsWith('heat')
                  ? '#7f1d1d'
                  : passengerSeat.startsWith('cool')
                  ? '#0c4a6e'
                  : '#1e293b'
              }
              stroke={
                passengerSeat.startsWith('heat')
                  ? '#ef4444'
                  : passengerSeat.startsWith('cool')
                  ? '#38bdf8'
                  : '#334155'
              }
              strokeWidth="1.5"
            />
            <rect x="216" y="328" width="30" height="12" rx="4" fill="#334155" />
          </g>

          {/* Rear Passenger Bench */}
          <rect x="130" y="390" width="120" height="42" rx="8" fill="#1e293b" stroke="#334155" strokeWidth="1.2" />
        </g>
      )}

      {/* 17. Powertrain X-Ray View (800V E-GMP Skateboard Architecture) */}
      {perspective === 'powertrain' && (
        <g id="powertrain-xray-view" className="animate-fadeIn">
          {/* Skateboard Chassis Battery Enclosure */}
          <rect
            x="105"
            y="230"
            width="170"
            height="260"
            rx="14"
            fill="#0369a1"
            fillOpacity="0.3"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeDasharray="5 3"
          />
          {/* Front Electric Drive Unit / Inverter */}
          <rect x="150" y="150" width="80" height="46" rx="8" fill="#0284c7" fillOpacity="0.45" stroke="#38bdf8" strokeWidth="1.5" />
          <text x="190" y="178" textAnchor="middle" fill="#7dd3fc" fontSize="9" fontWeight="bold" fontFamily="monospace">
            FRONT EDU
          </text>
          {/* Rear Electric Drive Unit / Inverter */}
          <rect x="150" y="520" width="80" height="46" rx="8" fill="#0284c7" fillOpacity="0.45" stroke="#38bdf8" strokeWidth="1.5" />
          <text x="190" y="548" textAnchor="middle" fill="#7dd3fc" fontSize="9" fontWeight="bold" fontFamily="monospace">
            REAR EDU
          </text>
          {/* 800V High Voltage Bus Rails */}
          <line x1="190" y1="196" x2="190" y2="520" stroke="#f59e0b" strokeWidth="3" strokeDasharray="6 3" />

          {/* Active High-Voltage Charging Stream into 800V Pack */}
          {chargingActive && (
            <g id="powertrain-charging-stream">
              <path
                d="M 296 510 C 270 510, 240 495, 215 480 L 190 470 L 190 235"
                stroke="#34d399"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
                className="charge-dot-stream"
              />
              <rect
                x="105"
                y="230"
                width="170"
                height="260"
                rx="14"
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
                opacity="0.85"
                filter="url(#chargingAuraGlow)"
              />
            </g>
          )}
          {/* Battery Cell Modules Grid */}
          <g opacity="0.85">
            {[0, 1, 2, 3].map(row => (
              <g key={row}>
                <rect x="116" y={245 + row * 58} width="66" height="48" rx="6" fill="#0c4a6e" stroke="#0284c7" strokeWidth="1" />
                <rect x="198" y={245 + row * 58} width="66" height="48" rx="6" fill="#0c4a6e" stroke="#0284c7" strokeWidth="1" />
              </g>
            ))}
          </g>
          <text x="190" y="365" textAnchor="middle" fill="#38bdf8" fontSize="12" fontWeight="bold" fontFamily="monospace">
            800V E-GMP PACK
          </text>
        </g>
      )}
    </svg>
  );
};
