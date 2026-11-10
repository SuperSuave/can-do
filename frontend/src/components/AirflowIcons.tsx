import React from 'react';
import type { AirflowMode } from './VehicleDashboard';

export const AIRFLOW_MODE_LABELS: Record<AirflowMode, string> = {
  auto: 'Auto',
  face: 'Face',
  face_feet: 'Face / Feet',
  feet: 'Feet',
  defrost: 'Defrost'
};

export interface AirflowDirectionIconProps {
  mode: AirflowMode;
  className?: string;
}

export interface ClimateSymbolIconProps {
  className?: string;
}

/**
 * Clean geometric ISO-style automotive HVAC airflow icons on a `44x36` canvas
 * sized for up to `~52x42px` inside the 5-tab Climate Airflow selector.
 */
const OCCUPANT_BODY_PATH =
  'M 31.6 12.6 L 35.8 13.4 L 32.8 24.4 H 26.2 L 22.2 31.2 A 1.6 1.6 0 0 1 19.3 29.3 L 23.3 21.8 Q 23.9 20.6 25.2 20.6 H 29.0 L 30.6 14.0 Q 30.9 12.6 31.6 12.6 Z';

const SEAT_FRAME_PATH =
  'M 40.4 11.2 L 36.4 26.0 Q 36.0 27.6 34.1 27.6 H 26.8';

const ARROW_FACE_PATH =
  'M 6.5 8.0 H 18.2 V 5.0 L 25.4 9.2 L 18.2 13.4 V 10.4 H 6.5 Z';

const ARROW_FEET_PATH =
  'M 10.6 18.4 H 13.0 V 25.6 H 16.0 L 11.8 32.4 L 7.6 25.6 H 10.6 Z';

const WINDSHIELD_FRAME_PATH =
  'M 2.2 5.4 Q 12.2 1.8 22.2 5.4 L 18.6 13.4 Q 12.2 11.4 5.8 13.4 Z';

const EV6_WHEEL_RIM_PATH =
  'M 9.4 11.2 A 8.0 7.8 0 0 1 25.4 11.2 C 25.4 15.0 23.6 18.2 20.6 18.4 H 14.2 C 11.2 18.2 9.4 15.0 9.4 11.2 Z';

const EV6_WHEEL_HUB_SPOKES_PATH =
  'M 9.6 10.0 L 14.2 9.0 Q 17.4 8.5 20.6 9.0 L 25.2 10.0 V 12.6 L 20.2 13.6 Q 17.4 14.3 14.6 13.6 L 9.6 12.6 Z';

/**
 * Shared curved front windshield + 2 wavy rising heat arrows (`x: 2.2..22.2, y: 1.8..15.6`).
 */
const FrontWindshieldSymbol: React.FC = () => (
  <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <path d={WINDSHIELD_FRAME_PATH} strokeWidth={1.9} />
    {[9.0, 15.4].map(x => (
      <React.Fragment key={x}>
        <path
          d={`M ${x} 15.6 Q ${x - 1.25} 13.4 ${x} 11.7 T ${x} 8.0`}
          strokeWidth={1.7}
        />
        <path
          d={`M ${x - 2.1} 8.6 L ${x} 5.7 L ${x + 2.1} 8.6 Z`}
          fill="currentColor"
          strokeWidth={0.6}
        />
      </React.Fragment>
    ))}
  </g>
);

export const AirflowDirectionIcon: React.FC<AirflowDirectionIconProps> = ({
  mode,
  className = 'w-[52px] max-w-full h-[42px]'
}) => {
  const showFace = mode === 'face' || mode === 'face_feet';
  const showFeet = mode === 'feet' || mode === 'face_feet' || mode === 'defrost';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 44 36"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      {/* Shared Seated Occupant & Seat */}
      <circle cx="34.2" cy="7.5" r="3.4" fill="currentColor" />
      <path d={OCCUPANT_BODY_PATH} fill="currentColor" />
      <path
        d={SEAT_FRAME_PATH}
        stroke="currentColor"
        strokeWidth={2.0}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* AUTO Badge (real UI font) */}
      {mode === 'auto' && (
        <text
          x="13.5"
          y="15.2"
          textAnchor="middle"
          fill="currentColor"
          fontFamily="'Plus Jakarta Sans', system-ui, sans-serif"
          fontSize="7.6"
          fontWeight="700"
          letterSpacing="0.02em"
        >
          AUTO
        </text>
      )}

      {/* Face / Upper Vent Arrow */}
      {showFace && (
        <path
          d={ARROW_FACE_PATH}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      )}

      {/* Floor / Feet Vent Arrow */}
      {showFeet && (
        <path
          d={ARROW_FEET_PATH}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={0.8}
          strokeLinejoin="round"
        />
      )}

      {/* Windshield Defrost */}
      {mode === 'defrost' && <FrontWindshieldSymbol />}
    </svg>
  );
};

export const FrontDefrostIcon: React.FC<ClimateSymbolIconProps> = ({
  className = 'w-8 h-6'
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0.2 1.4 24 16.5"
    className={className}
    fill="none"
    aria-hidden="true"
  >
    <FrontWindshieldSymbol />
  </svg>
);

export const RearDefrostIcon: React.FC<ClimateSymbolIconProps> = ({
  className = 'w-8 h-6'
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 18"
    className={className}
    fill="none"
    aria-hidden="true"
  >
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.2" y="2.4" width="19.6" height="11.2" rx="1.7" strokeWidth={1.85} />
      {[7.2, 12.0, 16.8].map(x => (
        <React.Fragment key={x}>
          <path
            d={`M ${x} 16.0 Q ${x - 1.05} 13.8 ${x} 11.8 T ${x} 7.6`}
            strokeWidth={1.5}
          />
          <path
            d={`M ${x - 1.75} 8.2 L ${x} 5.1 L ${x + 1.75} 8.2 Z`}
            fill="currentColor"
            strokeWidth={0.5}
          />
        </React.Fragment>
      ))}
    </g>
  </svg>
);

export const HeatedWheelIcon: React.FC<ClimateSymbolIconProps> = ({
  className = 'w-8 h-6'
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 27 22"
    className={className}
    fill="none"
    aria-hidden="true"
  >
    {/* Two bold rising heat waves */}
    {[2.6, 5.4].map(x => (
      <path
        key={x}
        d={`M ${x} 16.2 Q ${x - 0.9} 13.7 ${x} 11.2 T ${x} 6.2`}
        stroke="currentColor"
        strokeWidth={1.55}
        strokeLinecap="round"
      />
    ))}
    {/* '23 Kia EV6 flat-bottom 2-spoke D-wheel */}
    <path
      d={EV6_WHEEL_RIM_PATH}
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinejoin="round"
    />
    <path d={EV6_WHEEL_HUB_SPOKES_PATH} fill="currentColor" />
  </svg>
);
