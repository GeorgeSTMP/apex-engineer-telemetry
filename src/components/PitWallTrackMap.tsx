import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Crosshair, Download, LocateFixed, Maximize2, Navigation } from 'lucide-react';
import {
  buildPitWallCarRoster,
  computeCarLabelLayouts,
  computeFollowZoomViewBox,
  getSectorBoundaries,
  interpolateTrackPose,
  type PitWallTrackedCar,
} from '../engine/trackMapRadar';
import type {
  CarProfile,
  CornerDefinition,
  PitWallMapSize,
  PitWallMapViewMode,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';

export type MapClassFilter = 'all' | 'Hypercar' | 'LMP2' | 'LMGT3';

interface PitWallTrackMapProps {
  track: TrackProfile;
  car: CarProfile;
  frame: TelemetryFrame;
  activeCorner: CornerDefinition | null;
  mapSize: PitWallMapSize;
  onChangeMapSize: (size: PitWallMapSize) => void;
  selectedCarId: string;
  onSelectCarId: (carId: string) => void;
}

const SIZE_OPTIONS: Array<{ id: PitWallMapSize; short: string; label: string }> = [
  { id: 'compact', short: 'S', label: 'Compact map size' },
  { id: 'standard', short: 'M', label: 'Standard map size' },
  { id: 'large', short: 'L', label: 'Large wide map size' },
  { id: 'full', short: 'XL', label: 'Full pit wall map size' },
];

const MAP_CONTAINER_HEIGHT: Record<PitWallMapSize, string> = {
  compact: 'h-[168px]',
  standard: 'h-[212px]',
  large: 'h-[310px]',
  full: 'h-[420px]',
};

function getCarMarkerPalette(tracked: PitWallTrackedCar): {
  fill: string;
  stroke: string;
  ring: string | null;
} {
  if (tracked.isPlayer) {
    return { fill: '#06B6D4', stroke: '#ECFEFF', ring: '#06B6D4' };
  }
  if (tracked.inPits) {
    return { fill: '#64748B', stroke: '#0F172A', ring: null };
  }
  if (tracked.status === 'alongside') {
    return { fill: '#F43F5E', stroke: '#FFE4E6', ring: '#F43F5E' };
  }
  if (tracked.status === 'slow') {
    return { fill: '#EF4444', stroke: '#FEE2E2', ring: '#EF4444' };
  }
  if (tracked.status === 'threat') {
    return { fill: '#F59E0B', stroke: '#FEF3C7', ring: '#F59E0B' };
  }
  if (tracked.status === 'attack') {
    return { fill: '#10B981', stroke: '#D1FAE5', ring: '#10B981' };
  }
  if (tracked.carClass === 'LMP2') {
    return { fill: '#60A5FA', stroke: '#090B10', ring: null };
  }
  if (tracked.carClass === 'LMGT3') {
    return { fill: '#34D399', stroke: '#090B10', ring: null };
  }
  return { fill: '#FB923C', stroke: '#090B10', ring: null };
}

const CAR_DETAILS_EXPANDED_KEY = 'apexEngineer.pitWallCarDetailsExpanded.v1';

export function PitWallTrackMap({
  track,
  car,
  frame,
  activeCorner,
  mapSize,
  onChangeMapSize,
  selectedCarId,
  onSelectCarId,
}: PitWallTrackMapProps) {
  const [viewMode, setViewMode] = useState<PitWallMapViewMode>('circuit');
  const [zoomFactor, setZoomFactor] = useState<number>(2.5);
  const [classFilter, setClassFilter] = useState<MapClassFilter>('all');
  const [detailsExpanded, setDetailsExpanded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(CAR_DETAILS_EXPANDED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(CAR_DETAILS_EXPANDED_KEY, String(detailsExpanded));
    } catch {
      // Ignore storage errors
    }
  }, [detailsExpanded]);

  const roster = useMemo(
    () => buildPitWallCarRoster(frame, track, car),
    [frame, track, car]
  );

  const visibleRoster = useMemo(() => {
    if (classFilter === 'all') return roster;
    return roster.filter((entry) => entry.isPlayer || entry.carClass === classFilter);
  }, [roster, classFilter]);

  const selectedCar = useMemo(() => {
    return (
      roster.find((entry) => entry.id === selectedCarId) ??
      roster[0]
    );
  }, [roster, selectedCarId]);

  const playerEntry = roster[0];
  const followTarget = selectedCar ?? playerEntry;

  const activeViewBox = useMemo(() => {
    if (viewMode === 'follow' && followTarget) {
      return computeFollowZoomViewBox(track, followTarget.pose, zoomFactor);
    }
    return track.svgViewBox;
  }, [viewMode, followTarget, track, zoomFactor]);

  const sectorBoundaries = useMemo(() => getSectorBoundaries(track), [track]);

  const hazardPose = frame.hazardAhead
    ? interpolateTrackPose(track, (frame.lapDistPct + 0.025) % 1)
    : null;

  const sfStart = track.pathPoints[0] ?? { x: 500, y: 270 };
  const sfNext = track.pathPoints[1] ?? sfStart;
  const sfDx = sfNext.x - sfStart.x;
  const sfDy = sfNext.y - sfStart.y;
  const sfLen = Math.hypot(sfDx, sfDy) || 1;
  const sfNx = (-sfDy / sfLen) * 12;
  const sfNy = (sfDx / sfLen) * 12;

  const markerScale = viewMode === 'follow' ? Math.max(0.45, 1 / Math.sqrt(zoomFactor)) : 1;
  const isWideLayout = mapSize === 'large' || mapSize === 'full';
  const labelLayouts = useMemo(
    () => computeCarLabelLayouts(visibleRoster, activeViewBox, markerScale, selectedCar?.id),
    [visibleRoster, activeViewBox, markerScale, selectedCar?.id]
  );
  const availableClasses = useMemo(() => {
    const classes = new Set<'Hypercar' | 'LMP2' | 'LMGT3'>();
    roster.forEach((entry) => classes.add(entry.carClass));
    return classes;
  }, [roster]);

  return (
    <div className="flex min-w-0 flex-col" data-testid="pitwall-track-map-container" data-map-size={mapSize}>
      {/* Map Header & Controls */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-200">{track.name}</span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="font-mono text-[11px] tabular-nums text-slate-400 whitespace-nowrap">
            {Math.round(frame.lapDistPct * track.lengthKm * 1000)}m /{' '}
            {Math.round(track.lengthKm * 1000)}m
          </span>
          <span className="text-slate-600" aria-hidden="true">·</span>
          <span className="font-mono text-[11px] tabular-nums text-cyan-300 whitespace-nowrap" data-testid="map-cars-count">
            {roster.length} {roster.length === 1 ? 'car' : 'cars'} tracked
          </span>
        </div>

        <div className="flex max-w-full flex-wrap items-center gap-1.5">
          {/* Class Filter (shown when multiple classes present) */}
          {availableClasses.size > 1 && (
            <div
              role="group"
              aria-label="Filter cars by class"
              className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5"
            >
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'Hypercar', label: 'HY' },
                  { id: 'LMP2', label: 'P2' },
                  { id: 'LMGT3', label: 'GT3' },
                ] as Array<{ id: MapClassFilter; label: string }>
              )
                .filter((opt) => opt.id === 'all' || availableClasses.has(opt.id))
                .map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setClassFilter(opt.id)}
                    aria-pressed={classFilter === opt.id}
                    data-testid={`map-class-filter-${opt.id}`}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      classFilter === opt.id
                        ? 'bg-[#1D273B] text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
            </div>
          )}

          {/* Camera Mode: Full Circuit vs Follow Selected Car */}
          <div
            role="group"
            aria-label="Map camera mode"
            className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5"
          >
            <button
              type="button"
              onClick={() => setViewMode('circuit')}
              aria-pressed={viewMode === 'circuit'}
              data-testid="map-view-circuit"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'circuit'
                  ? 'bg-[#1D273B] text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Maximize2 className="h-2.5 w-2.5" aria-hidden="true" />
              <span>Full</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('follow')}
              aria-pressed={viewMode === 'follow'}
              data-testid="map-view-follow"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'follow'
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LocateFixed className="h-2.5 w-2.5" aria-hidden="true" />
              <span>Follow</span>
            </button>
            {viewMode === 'follow' && (
              <button
                type="button"
                onClick={() => setZoomFactor((z) => (z >= 3.5 ? 2.0 : Math.round((z + 0.75) * 100) / 100))}
                title="Cycle radar zoom magnification"
                data-testid="map-zoom-cycle"
                className="rounded px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 hover:bg-[#161E2E] cursor-pointer whitespace-nowrap"
              >
                {zoomFactor.toFixed(1)}x
              </button>
            )}
          </div>

          {/* Multi-Size Selector: S / M / L / XL */}
          <div
            role="group"
            aria-label="Track map size"
            data-testid="track-map-size-selector"
            className="flex items-center gap-0.5 rounded border border-[#1B2230] bg-[#090B10] p-0.5"
          >
            {SIZE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeMapSize(opt.id)}
                aria-label={opt.label}
                aria-pressed={mapSize === opt.id}
                title={opt.label}
                data-testid={`map-size-${opt.id}`}
                className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  mapSize === opt.id
                    ? 'bg-cyan-500 text-slate-950'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.short}
              </button>
            ))}
          </div>

          <a
            href={`/minimaps/${track.id}.svg`}
            download={`${track.id}-minimap.svg`}
            title={`Download ${track.name} SVG minimap`}
            className="inline-flex items-center gap-1 rounded border border-[#273145] bg-[#090B10] px-1.5 py-0.5 font-mono text-[10px] text-slate-400 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 whitespace-nowrap"
          >
            <Download className="h-2.5 w-2.5" aria-hidden="true" />
            <span>SVG</span>
          </a>
        </div>
      </div>

      {/* Main SVG Radar Canvas */}
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-md border border-[#1B2230] bg-[#090B10] p-2 ${MAP_CONTAINER_HEIGHT[mapSize]}`}
      >
        <svg
          viewBox={activeViewBox}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full"
          aria-label={`${track.name} live track map`}
          data-testid="track-map-svg"
        >
          {/* Outer Track Curb / Casing */}
          <path
            d={track.svgPath}
            fill="none"
            stroke="#1E293B"
            strokeWidth={13 * markerScale}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* Racing Surface Centerline */}
          <path
            d={track.svgPath}
            fill="none"
            stroke="#334155"
            strokeWidth={3.6 * markerScale}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Sector Divider Lines (S1/S2 & S2/S3) */}
          {sectorBoundaries.map((sb) => (
            <g key={sb.label}>
              <line
                x1={sb.x - sb.nx * markerScale}
                y1={sb.y - sb.ny * markerScale}
                x2={sb.x + sb.nx * markerScale}
                y2={sb.y + sb.ny * markerScale}
                stroke="#475569"
                strokeWidth={2 * markerScale}
                strokeDasharray={`${3 * markerScale} ${2 * markerScale}`}
              />
              <text
                x={sb.x + sb.nx * 1.9 * markerScale}
                y={sb.y + sb.ny * 1.9 * markerScale}
                textAnchor="middle"
                className="fill-slate-500 font-mono"
                style={{ fontSize: `${10.5 * markerScale}px` }}
              >
                {sb.label}
              </text>
            </g>
          ))}

          {/* Start / Finish Line */}
          <line
            x1={sfStart.x - sfNx * markerScale}
            y1={sfStart.y - sfNy * markerScale}
            x2={sfStart.x + sfNx * markerScale}
            y2={sfStart.y + sfNy * markerScale}
            stroke="#F8FAFC"
            strokeWidth={4 * markerScale}
            strokeLinecap="round"
          />

          {/* Corner Markers */}
          {track.corners.map((corner) => {
            const isCurrent = activeCorner?.id === corner.id;
            const labelY =
              corner.mapPoint.y < 36
                ? corner.mapPoint.y + 22 * markerScale
                : corner.mapPoint.y - 11 * markerScale;
            return (
              <g key={corner.id}>
                <circle
                  cx={corner.mapPoint.x}
                  cy={corner.mapPoint.y}
                  r={(isCurrent ? 8.5 : 5) * markerScale}
                  fill={isCurrent ? '#F59E0B' : '#0F172A'}
                  stroke={isCurrent ? '#FEF3C7' : '#475569'}
                  strokeWidth={1.8 * markerScale}
                />
                <text
                  x={corner.mapPoint.x}
                  y={labelY}
                  textAnchor="middle"
                  className="fill-slate-400 font-mono"
                  style={{ fontSize: `${(isWideLayout ? 13.5 : 14) * markerScale}px` }}
                >
                  T{corner.number}
                </text>
              </g>
            );
          })}

          {/* Track Hazard Marker */}
          {hazardPose && (
            <polygon
              points={`${hazardPose.x},${hazardPose.y - 14 * markerScale} ${hazardPose.x + 12 * markerScale},${hazardPose.y + 7 * markerScale} ${hazardPose.x - 12 * markerScale},${hazardPose.y + 7 * markerScale}`}
              fill="#EF4444"
              stroke="#FEE2E2"
              strokeWidth={1.8 * markerScale}
            />
          )}

          {/* Opponents (directional chevrons + non-overlapping number + selection reticle) */}
          {visibleRoster
            .filter((entry) => !entry.isPlayer)
            .map((opp) => {
              const palette = getCarMarkerPalette(opp);
              const isSelected = selectedCar?.id === opp.id;
              const chevronScale =
                (opp.status === 'alongside' || opp.status === 'threat' || opp.status === 'attack'
                  ? 1.15
                  : 0.95) * markerScale;
              const label = labelLayouts.get(opp.id);
              const labelX = label?.x ?? opp.pose.x;
              const labelY = label?.y ?? opp.pose.y - 14 * markerScale;
              const labelAnchor = label?.textAnchor ?? 'middle';
              const labelFontSize = label?.fontSize ?? 11.5 * markerScale;
              const labelText =
                label?.labelText ?? (opp.inPits ? `#${opp.carNumber} PIT` : `#${opp.carNumber}`);

              return (
                <g
                  key={opp.id}
                  onClick={() => onSelectCarId(opp.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select #${opp.carNumber} ${opp.driverName} (${opp.carClass})`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectCarId(opp.id);
                    }
                  }}
                  style={{ cursor: 'pointer' }}
                  data-testid={`map-car-marker-${opp.id}`}
                >
                  {label?.showLeader && (
                    <line
                      x1={label.leaderX1}
                      y1={label.leaderY1}
                      x2={label.leaderX2}
                      y2={label.leaderY2}
                      stroke={isSelected ? '#94A3B8' : '#475569'}
                      strokeWidth={1.1 * markerScale}
                      strokeOpacity={0.75}
                    />
                  )}
                  {isSelected && (
                    <circle
                      cx={opp.pose.x}
                      cy={opp.pose.y}
                      r={14 * markerScale}
                      fill="none"
                      stroke="#F8FAFC"
                      strokeWidth={1.8 * markerScale}
                      strokeDasharray={`${4 * markerScale} ${3 * markerScale}`}
                    />
                  )}
                  {palette.ring && (
                    <circle
                      cx={opp.pose.x}
                      cy={opp.pose.y}
                      r={10 * markerScale}
                      fill={palette.ring}
                      fillOpacity={0.18}
                    />
                  )}
                  <g
                    transform={`translate(${opp.pose.x}, ${opp.pose.y}) rotate(${opp.pose.headingDeg}) scale(${chevronScale})`}
                  >
                    <path
                      d="M 8.5 0 L -6 -5.2 L -3.2 0 L -6 5.2 Z"
                      fill={palette.fill}
                      stroke={palette.stroke}
                      strokeWidth={1.4}
                      strokeLinejoin="round"
                    />
                  </g>
                  <text
                    x={labelX}
                    y={labelY}
                    textAnchor={labelAnchor}
                    dominantBaseline="central"
                    stroke="#090B10"
                    strokeWidth={3.2 * markerScale}
                    paintOrder="stroke"
                    className={`font-mono font-semibold ${
                      opp.inPits
                        ? 'fill-slate-400'
                        : isSelected
                          ? 'fill-white'
                          : 'fill-slate-200'
                    }`}
                    style={{ fontSize: `${labelFontSize}px` }}
                  >
                    {labelText}
                  </text>
                </g>
              );
            })}

          {/* Player Car (always rendered on top for zero occlusion) */}
          {playerEntry && (() => {
            const playerLabel = labelLayouts.get(playerEntry.id);
            const playerLabelX = playerLabel?.x ?? playerEntry.pose.x;
            const playerLabelY = playerLabel?.y ?? playerEntry.pose.y + 18 * markerScale;
            const playerLabelAnchor = playerLabel?.textAnchor ?? 'middle';
            const playerLabelText =
              playerLabel?.labelText ??
              (playerEntry.position ? `P${playerEntry.position} YOU` : 'YOU');

            return (
              <g
                onClick={() => onSelectCarId(playerEntry.id)}
                role="button"
                tabIndex={0}
                aria-label="Select Player Car"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectCarId(playerEntry.id);
                  }
                }}
                style={{ cursor: 'pointer' }}
                data-testid="map-car-marker-player"
              >
                {playerLabel?.showLeader && (
                  <line
                    x1={playerLabel.leaderX1}
                    y1={playerLabel.leaderY1}
                    x2={playerLabel.leaderX2}
                    y2={playerLabel.leaderY2}
                    stroke="#22D3EE"
                    strokeWidth={1.2 * markerScale}
                    strokeOpacity={0.7}
                  />
                )}
                <circle
                  cx={playerEntry.pose.x}
                  cy={playerEntry.pose.y}
                  r={13 * markerScale}
                  fill="#06B6D4"
                  fillOpacity={0.22}
                />
                {selectedCar?.isPlayer && (
                  <circle
                    cx={playerEntry.pose.x}
                    cy={playerEntry.pose.y}
                    r={16 * markerScale}
                    fill="none"
                    stroke="#ECFEFF"
                    strokeWidth={1.6 * markerScale}
                    strokeDasharray={`${4 * markerScale} ${3 * markerScale}`}
                  />
                )}
                <g
                  transform={`translate(${playerEntry.pose.x}, ${playerEntry.pose.y}) rotate(${playerEntry.pose.headingDeg}) scale(${1.2 * markerScale})`}
                >
                  <path
                    d="M 9.5 0 L -6.8 -5.8 L -3.5 0 L -6.8 5.8 Z"
                    fill="#06B6D4"
                    stroke="#ECFEFF"
                    strokeWidth={1.6}
                    strokeLinejoin="round"
                  />
                </g>
                <text
                  x={playerLabelX}
                  y={playerLabelY}
                  textAnchor={playerLabelAnchor}
                  dominantBaseline="central"
                  stroke="#090B10"
                  strokeWidth={3.5 * markerScale}
                  paintOrder="stroke"
                  className="fill-cyan-300 font-mono font-bold"
                  style={{ fontSize: `${playerLabel?.fontSize ?? 12 * markerScale}px` }}
                >
                  {playerLabelText}
                </text>
              </g>
            );
          })()}
        </svg>

        {/* Compact Unboxed Legend Overlay (bottom-left of radar canvas) */}
        <div className="pointer-events-none absolute bottom-2 left-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-[#090B10]/85 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
          <span className="text-cyan-300">▸ YOU</span>
          <span className="text-orange-400">▸ HY</span>
          <span className="text-blue-400">▸ P2</span>
          <span className="text-emerald-400">▸ GT3</span>
          <span className="text-rose-400">▸ Alongside</span>
          <span className="text-slate-500">▸ PIT</span>
        </div>
      </div>

      {/* Collapsible Selected Car Location Readout (Minimal by default, expandable for full grid) */}
      {selectedCar && (
        <div
          className="mt-2 border-t border-[#1B2230] pt-2"
          data-testid="selected-car-location-panel"
          data-expanded={detailsExpanded ? 'true' : 'false'}
        >
          {/* Persistent Top Summary Bar (stays anchored whether minimal or expanded) */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 text-xs">
            {detailsExpanded ? (
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <Crosshair className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden="true" />
                  <span className="font-mono font-semibold text-slate-100">
                    {selectedCar.isPlayer ? 'YOU' : `#${selectedCar.carNumber}`}
                  </span>
                  <span className="font-medium text-slate-200 truncate">{selectedCar.driverName}</span>
                  {selectedCar.position !== undefined && (
                    <>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className="font-mono text-[11px] font-semibold text-cyan-300 tabular-nums">
                        P{selectedCar.position}
                      </span>
                    </>
                  )}
                  {selectedCar.lapsCompleted !== undefined && (
                    <>
                      <span className="text-slate-600" aria-hidden="true">·</span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        Lap {selectedCar.lapsCompleted + 1}
                      </span>
                    </>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400 pl-5">
                  <span className="truncate">{selectedCar.carName}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span className="font-mono text-slate-300">{selectedCar.carClass}</span>
                  <span className="text-slate-600" aria-hidden="true">·</span>
                  <span
                    className={`font-mono ${
                      selectedCar.status === 'alongside' || selectedCar.status === 'slow'
                        ? 'font-semibold text-rose-400'
                        : selectedCar.status === 'threat' || selectedCar.status === 'pit'
                          ? 'font-semibold text-amber-300'
                          : selectedCar.status === 'attack'
                            ? 'font-semibold text-emerald-400'
                            : 'text-cyan-300'
                    }`}
                  >
                    {selectedCar.statusLabel}
                  </span>
                </div>
              </div>
            ) : (
              <div
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] tabular-nums py-0.5"
                data-testid="selected-car-minimal-summary"
              >
                <Crosshair className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden="true" />
                <span className="font-semibold text-slate-100 shrink-0">
                  {selectedCar.isPlayer ? 'YOU' : `#${selectedCar.carNumber}`}
                </span>
                {selectedCar.position !== undefined && (
                  <span className="text-cyan-300 shrink-0">P{selectedCar.position}</span>
                )}
                <span className="text-slate-600 shrink-0" aria-hidden="true">·</span>
                <span className="min-w-0 truncate text-slate-300">
                  S{selectedCar.location.sector} · {selectedCar.location.zoneLabel}
                </span>
                <span className="text-slate-600 shrink-0" aria-hidden="true">·</span>
                <span className="text-slate-100 shrink-0 whitespace-nowrap">{selectedCar.speedKmh} km/h</span>
                {!selectedCar.isPlayer && (
                  <>
                    <span className="hidden sm:inline text-slate-600 shrink-0" aria-hidden="true">·</span>
                    <span className="hidden sm:inline text-slate-400 shrink-0">
                      {selectedCar.distanceMeters >= 0 ? '+' : ''}{Math.round(selectedCar.distanceMeters)}m
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-1.5 font-mono text-[11px] shrink-0">
              <button
                type="button"
                onClick={() => setViewMode((m) => (m === 'follow' ? 'circuit' : 'follow'))}
                className="inline-flex items-center gap-1 rounded border border-[#273145] bg-[#090B10] px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200 cursor-pointer whitespace-nowrap"
              >
                <Navigation className="h-2.5 w-2.5" aria-hidden="true" />
                <span>{viewMode === 'follow' ? 'Full View' : 'Zoom Car'}</span>
              </button>
              <button
                type="button"
                onClick={() => setDetailsExpanded((prev) => !prev)}
                aria-expanded={detailsExpanded}
                aria-controls="selected-car-full-details"
                aria-label={detailsExpanded ? 'Minimize car location details' : 'Expand full car location details'}
                data-testid="toggle-car-details"
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[10px] transition-colors cursor-pointer whitespace-nowrap ${
                  detailsExpanded
                    ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                    : 'border-[#273145] bg-[#090B10] text-slate-300 hover:border-cyan-500/50 hover:text-cyan-200'
                }`}
              >
                <span>{detailsExpanded ? 'Minimal' : 'Details'}</span>
                {detailsExpanded ? (
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {/* Expandable Car Selector Chips + Full Telemetry Grid */}
          {detailsExpanded && (
            <div id="selected-car-full-details" className="mt-2">
              <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-1">
                {visibleRoster.map((entry) => {
                  const active = entry.id === selectedCar.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => onSelectCarId(entry.id)}
                      data-testid={`select-car-chip-${entry.id}`}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        active
                          ? entry.isPlayer
                            ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 font-semibold'
                            : 'border-slate-300 bg-[#1D273B] text-white font-semibold'
                          : 'border-[#1B2230] bg-[#090B10] text-slate-400 hover:border-slate-500 hover:text-slate-200'
                      }`}
                    >
                      <span>{entry.isPlayer ? 'YOU' : `#${entry.carNumber}`}</span>
                      <span className="text-[10px] text-slate-500">{entry.classShort}</span>
                      {entry.inPits && <span className="text-[10px] text-amber-300">PIT</span>}
                    </button>
                  );
                })}
              </div>

              <div
                className={`grid gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-slate-300 ${
                  isWideLayout ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2'
                }`}
                data-testid="selected-car-telemetry-metrics"
              >
                <div className="col-span-full">
                  <span className="text-slate-500">Location </span>
                  <span className="text-slate-100">
                    S{selectedCar.location.sector} · {selectedCar.location.zoneLabel}
                  </span>
                </div>
                <div className="whitespace-nowrap">
                  <span className="text-slate-500">Track </span>
                  <span>
                    {selectedCar.location.trackDistanceM}m ({selectedCar.location.lapPctLabel})
                  </span>
                </div>
                <div className="whitespace-nowrap">
                  <span className="text-slate-500">Speed </span>
                  <span className="text-slate-100">{selectedCar.speedKmh} km/h</span>
                </div>

                <div className="whitespace-nowrap">
                  <span className="text-slate-500">Gap </span>
                  <span>
                    {selectedCar.isPlayer
                      ? 'Reference'
                      : `${selectedCar.distanceMeters >= 0 ? '+' : ''}${Math.round(selectedCar.distanceMeters)}m (${selectedCar.gapSeconds >= 0 ? '+' : ''}${selectedCar.gapSeconds.toFixed(2)}s)`}
                  </span>
                </div>
                <div className="whitespace-nowrap">
                  <span className="text-slate-500">Closing </span>
                  <span className={selectedCar.closingSpeedKmh >= 5 ? 'text-cyan-300' : ''}>
                    {selectedCar.isPlayer
                      ? '—'
                      : `${selectedCar.closingSpeedKmh >= 0 ? '+' : ''}${Math.round(selectedCar.closingSpeedKmh)} km/h`}
                  </span>
                </div>
                <div className="whitespace-nowrap">
                  <span className="text-slate-500">Heading </span>
                  <span>{Math.round(selectedCar.pose.headingDeg)}°</span>
                </div>
                <div className="whitespace-nowrap">
                  {selectedCar.posX !== undefined && selectedCar.posZ !== undefined ? (
                    <>
                      <span className="text-slate-500">World </span>
                      <span>
                        {selectedCar.posX.toFixed(1)}, {selectedCar.posZ.toFixed(1)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-slate-500">Side </span>
                      <span className="uppercase">{selectedCar.lateralSide}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
