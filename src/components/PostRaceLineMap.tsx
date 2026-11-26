import { useMemo, useState } from 'react';
import { Crosshair, Eye, EyeOff, Gauge, Navigation, Zap } from 'lucide-react';
import { CARS, TRACKS, buildReferenceLap } from '../data/circuitsAndCars';
import { buildCornerLineAnalysis } from '../engine/racingLine';
import type {
  CompactTelemetryPoint,
  CornerDefinition,
  DriverProfile,
  GreenLineMode,
  RaceReport,
} from '../types/telemetry';

interface PostRaceLineMapProps {
  report: RaceReport;
  selectedCornerId: string;
  onSelectCorner: (cornerId: string) => void;
  driverProfile?: DriverProfile;
  language?: 'en';
}

interface CornerDistPoint {
  m: number;
  speed: number;
  brake: number;
  throttle: number;
}

function wrapDeltaPct(startPct: number, ptPct: number): number {
  let d = ptPct - startPct;
  if (d < -0.5) d += 1;
  if (d > 0.5) d -= 1;
  return d;
}

function extractCornerDistPts(
  frames: CompactTelemetryPoint[] | undefined,
  corner: CornerDefinition,
  trackMeters: number
): CornerDistPoint[] {
  if (!frames || frames.length < 4) return [];
  let span = corner.exitPct - corner.startPct;
  if (span <= 0) span += 1;
  return frames
    .filter((f) => {
      const d = wrapDeltaPct(corner.startPct, f.lapDistPct);
      return d >= -0.008 && d <= span + 0.008;
    })
    .map((f) => ({
      m: wrapDeltaPct(corner.startPct, f.lapDistPct) * trackMeters,
      speed: f.speedKmh,
      brake: f.brake,
      throttle: f.throttle,
    }))
    .sort((a, b) => a.m - b.m);
}

function buildDistChartPath(
  pts: CornerDistPoint[],
  xFn: (m: number) => number,
  yFn: (val: number) => number,
  getVal: (p: CornerDistPoint) => number
): string {
  return pts
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xFn(p.m).toFixed(1)} ${yFn(getVal(p)).toFixed(1)}`)
    .join(' ');
}

function CornerDistanceChart({
  report,
  corner,
  lengthKm,
}: {
  report: RaceReport;
  corner: CornerDefinition;
  lengthKm: number;
}) {
  const trackMeters = Math.max(500, lengthKm * 1000);
  const lapPts = extractCornerDistPts(report.representativeFrames, corner, trackMeters);
  const bestPass = report.bestCornerPasses?.find((b) => b.cornerId === corner.id);
  const bestPts = extractCornerDistPts(bestPass?.frames, corner, trackMeters);
  if (lapPts.length < 4) return null;

  const minM = lapPts[0].m;
  const maxM = lapPts[lapPts.length - 1].m;
  const spanM = Math.max(8, maxM - minM);
  const xPos = (m: number) => 36 + ((m - minM) / spanM) * 596;
  const ySpeed = (s: number) => 8 + (1 - Math.max(0, Math.min(320, s)) / 320) * 58;
  const yThrottle = (t: number) => 78 + (1 - Math.max(0, Math.min(1, t))) * 32;
  const yBrake = (b: number) => 122 + (1 - Math.max(0, Math.min(1, b))) * 36;

  const lapBrakePt = lapPts.find((p) => p.brake >= 0.2);
  const lapSlowPt = lapPts.reduce((acc, cur) => (cur.speed < acc.speed ? cur : acc));
  const bestBrakePt = bestPts.find((p) => p.brake >= 0.2);
  const bestSlowPt = bestPts.length
    ? bestPts.reduce((acc, cur) => (cur.speed < acc.speed ? cur : acc))
    : null;

  let summaryText = `This is already your best pass of this corner. Brake begins ${Math.round(lapBrakePt?.m ?? minM)} m in. Slowest point ${Math.round(lapSlowPt.speed)} km/h.`;
  if (bestPts.length >= 4 && lapBrakePt && bestBrakePt && bestSlowPt) {
    const brakeDiffM = Math.round(bestBrakePt.m - lapBrakePt.m);
    const speedDiffKmh = Math.round(bestSlowPt.speed - lapSlowPt.speed);
    summaryText = `${
      Math.abs(brakeDiffM) < 2
        ? 'Same brake point as your best pass'
        : `Your best pass brakes ${Math.abs(brakeDiffM)} m ${brakeDiffM > 0 ? 'deeper' : 'earlier'}`
    }. ${Math.abs(speedDiffKmh)} km/h ${speedDiffKmh >= 0 ? 'quicker' : 'slower'} at the slow point.`;
  }

  const verticalMarkers = [lapBrakePt, lapSlowPt].filter((p): p is CornerDistPoint => Boolean(p));

  return (
    <div
      className="mt-2 rounded border border-[#1B2230] bg-[#07090D] px-2 py-2"
      data-testid="corner-distance-chart"
    >
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-slate-400">
        <span>Distance through the corner</span>
        <span>{bestPts.length >= 4 ? 'Solid fastest lap · dashed your best pass' : 'This lap'}</span>
      </div>
      <svg
        viewBox="0 0 640 168"
        className="h-[150px] w-full"
        role="img"
        aria-label="Speed, throttle and brake against distance"
      >
        <text x="4" y="28" fill="#64748b" fontSize="9" fontFamily="monospace">
          km/h
        </text>
        <text x="4" y="96" fill="#64748b" fontSize="9" fontFamily="monospace">
          thr
        </text>
        <text x="4" y="142" fill="#64748b" fontSize="9" fontFamily="monospace">
          brk
        </text>
        {verticalMarkers.map((pt, idx) => (
          <line
            key={idx}
            x1={xPos(pt.m)}
            x2={xPos(pt.m)}
            y1="8"
            y2="158"
            stroke={idx === 0 ? '#fb7185' : '#22d3ee'}
            strokeOpacity="0.45"
            strokeDasharray="3 3"
          />
        ))}
        {bestPts.length >= 4 && (
          <path
            d={buildDistChartPath(bestPts, xPos, ySpeed, (p) => p.speed)}
            fill="none"
            stroke="#64748b"
            strokeWidth="1.2"
            strokeDasharray="4 3"
          />
        )}
        <path
          d={buildDistChartPath(lapPts, xPos, ySpeed, (p) => p.speed)}
          fill="none"
          stroke="#22d3ee"
          strokeWidth="1.6"
        />
        {bestPts.length >= 4 && (
          <path
            d={buildDistChartPath(bestPts, xPos, yThrottle, (p) => p.throttle)}
            fill="none"
            stroke="#64748b"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
        )}
        <path
          d={buildDistChartPath(lapPts, xPos, yThrottle, (p) => p.throttle)}
          fill="none"
          stroke="#34d399"
          strokeWidth="1.4"
        />
        {bestPts.length >= 4 && (
          <path
            d={buildDistChartPath(bestPts, xPos, yBrake, (p) => p.brake)}
            fill="none"
            stroke="#64748b"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
        )}
        <path
          d={buildDistChartPath(lapPts, xPos, yBrake, (p) => p.brake)}
          fill="none"
          stroke="#fb7185"
          strokeWidth="1.4"
        />
      </svg>
      <p className="mt-1 font-mono text-[11px] text-slate-200">{summaryText}</p>
    </div>
  );
}

export function PostRaceLineMap({
  report,
  selectedCornerId,
  onSelectCorner,
  driverProfile,
  language = 'en',
}: PostRaceLineMapProps) {
  const [showRedLine, setShowRedLine] = useState(true);
  const [showGreenLine, setShowGreenLine] = useState(true);
  const [greenLineMode, setGreenLineMode] = useState<GreenLineMode>('auto');

  const track = useMemo(
    () => TRACKS.find((t) => t.id === report.trackId) ?? TRACKS[0],
    [report.trackId]
  );

  const car = useMemo(
    () => CARS.find((c) => c.id === report.carId) ?? CARS[0],
    [report.carId]
  );

  const referenceSamples = useMemo(() => buildReferenceLap(track, car), [track, car]);

  const activeCorner = useMemo(
    () => track.corners.find((c) => c.id === selectedCornerId) ?? track.corners[0],
    [track.corners, selectedCornerId]
  );

  const activeComparison = useMemo(
    () =>
      report.cornerComparisons.find((c) => c.cornerId === activeCorner.id) ?? null,
    [report.cornerComparisons, activeCorner.id]
  );

  const activeBestPass = useMemo(
    () => report.bestCornerPasses?.find((bp) => bp.cornerId === activeCorner.id) ?? null,
    [report.bestCornerPasses, activeCorner.id]
  );

  const analysis = useMemo(
    () =>
      buildCornerLineAnalysis({
        track,
        car,
        corner: activeCorner,
        comparison: activeComparison,
        referenceSamples,
        driverFrames: report.representativeFrames,
        driverProfile,
        bestCornerPassFrames: activeBestPass?.frames,
        bestCornerPassTimeSec: activeBestPass?.timeSec,
        greenLineMode,
        language,
      }),
    [
      track,
      car,
      activeCorner,
      activeComparison,
      referenceSamples,
      report.representativeFrames,
      driverProfile,
      activeBestPass,
      greenLineMode,
      language,
    ]
  );

  const overviewDims = useMemo(() => {
    const parts = track.svgViewBox.split(' ').map(Number);
    const w = parts[2] || 1000;
    const h = parts[3] || 550;
    const scale = Math.max(w, h) / 1000;
    return { scale };
  }, [track.svgViewBox]);

  const hw = analysis.trackHalfWidth;
  const markerR = Math.max(1.2, hw * 0.28);
  const labelFontSize = Math.max(3.2, hw * 0.62);

  // Build mini pedal/speed SVG paths (width 420 x height 96)
  const pedalPaths = useMemo(() => {
    const pts = analysis.pedalComparison;
    const w = 420;
    const h = 86;
    const toPath = (getVal: (p: (typeof pts)[number]) => number, maxVal = 1) =>
      pts
        .map((p, idx) => {
          const x = (idx / Math.max(1, pts.length - 1)) * w;
          const norm = Math.max(0, Math.min(1, getVal(p) / maxVal));
          const y = h - 8 - norm * (h - 16);
          return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');

    return {
      w,
      h,
      proBrake: toPath((p) => p.proBrake, 1),
      userBrake: toPath((p) => p.userBrake, 1),
      proThrottle: toPath((p) => p.proThrottle, 1),
      userThrottle: toPath((p) => p.userThrottle, 1),
    };
  }, [analysis.pedalComparison]);

  const comparisonByCornerId = useMemo(() => {
    const map = new Map<string, (typeof report.cornerComparisons)[number]>();
    for (const c of report.cornerComparisons) {
      map.set(c.cornerId, c);
    }
    return map;
  }, [report.cornerComparisons]);

  return (
    <section
      className="rounded-lg border border-[#1B2230] bg-[#10141D] p-5"
      data-testid="post-race-line-map"
    >
      {/* Header + Legend */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1B2230] pb-3.5">
        <div>
          <div className="flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-cyan-400" aria-hidden="true" />
            <h3 className="font-display text-base font-semibold text-slate-100">
              Corner Map Replay — Racing Line, Braking & Throttle Changes
            </h3>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Click any turn on the circuit or pills below: Red = your line, Green = {analysis.greenLineTitle.toLowerCase()} ({analysis.cornerArchetype}).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <div
            className="inline-flex items-center rounded border border-[#1B2230] bg-[#090B10] p-0.5"
            role="group"
            aria-label="Green racing line mode"
          >
            {([
              { id: 'auto', label: 'Auto' },
              { id: 'pro', label: 'Pro Line' },
              { id: 'learned', label: 'For You' },
            ] as const).map((opt) => {
              const active = greenLineMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`green-mode-${opt.id}`}
                  aria-pressed={active}
                  onClick={() => setGreenLineMode(opt.id)}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors cursor-pointer ${
                    active
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/45'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            aria-pressed={showRedLine}
            data-testid="toggle-red-line"
            onClick={() => setShowRedLine((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 transition-colors cursor-pointer ${
              showRedLine
                ? 'border-rose-500/55 bg-rose-500/15 text-rose-200 hover:border-rose-400'
                : 'border-[#1B2230] bg-[#090B10] text-slate-500 hover:border-[#2C374C] hover:text-slate-300'
            }`}
          >
            {showRedLine ? (
              <Eye className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
            )}
            <span
              className={`h-1 w-3.5 rounded-full ${showRedLine ? 'bg-rose-500' : 'bg-slate-600'}`}
              aria-hidden="true"
            />
            <span>Red (Yours)</span>
            <span
              className={`ml-0.5 rounded px-1 py-0.2 text-[9px] font-bold ${
                showRedLine ? 'bg-rose-500/25 text-rose-300' : 'bg-slate-800 text-slate-400'
              }`}
            >
              {showRedLine ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            aria-pressed={showGreenLine}
            data-testid="toggle-green-line"
            onClick={() => setShowGreenLine((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 transition-colors cursor-pointer ${
              showGreenLine
                ? 'border-emerald-500/55 bg-emerald-500/15 text-emerald-200 hover:border-emerald-400'
                : 'border-[#1B2230] bg-[#090B10] text-slate-500 hover:border-[#2C374C] hover:text-slate-300'
            }`}
          >
            {showGreenLine ? (
              <Eye className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
            )}
            <span
              className={`h-1 w-3.5 rounded-full ${showGreenLine ? 'bg-emerald-400' : 'bg-slate-600'}`}
              aria-hidden="true"
            />
            <span>
              {analysis.greenLineSource === 'proven_best'
                ? 'Green (Your Best)'
                : analysis.greenLineSource === 'learned'
                  ? 'Green (Learned)'
                  : 'Green (Pro)'}
            </span>
            <span
              className={`ml-0.5 rounded px-1 py-0.2 text-[9px] font-bold ${
                showGreenLine ? 'bg-emerald-500/25 text-emerald-300' : 'bg-slate-800 text-slate-400'
              }`}
            >
              {showGreenLine ? 'ON' : 'OFF'}
            </span>
          </button>

          {(!showRedLine || !showGreenLine) && (
            <button
              type="button"
              data-testid="toggle-both-lines"
              onClick={() => {
                setShowRedLine(true);
                setShowGreenLine(true);
              }}
              className="inline-flex items-center rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold text-cyan-300 transition-colors hover:border-cyan-400 cursor-pointer"
            >
              Show Both
            </button>
          )}
        </div>
      </div>

      {/* Turn Selector Pills */}
      <div
        className="mt-3 flex flex-wrap gap-1.5"
        role="tablist"
        aria-label="Select corner"
      >
        {track.corners.map((corner) => {
          const comp = comparisonByCornerId.get(corner.id);
          const isSelected = corner.id === activeCorner.id;
          const timeLost = comp?.timeLostSec ?? 0;
          const isHighLoss = timeLost >= 0.12;
          return (
            <button
              key={corner.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              data-testid={`map-corner-btn-${corner.id}`}
              onClick={() => onSelectCorner(corner.id)}
              className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] transition-colors cursor-pointer ${
                isSelected
                  ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200 font-semibold'
                  : isHighLoss
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:border-rose-400'
                    : 'border-[#1B2230] bg-[#090B10] text-slate-300 hover:border-[#2C374C]'
              }`}
            >
              <span>T{corner.number}</span>
              <span className="hidden sm:inline text-slate-400 truncate max-w-[110px]">
                {corner.name.split('(')[0].trim()}
              </span>
              {timeLost > 0.04 && (
                <span className={isHighLoss ? 'text-rose-300' : 'text-amber-300'}>
                  -{timeLost.toFixed(2)}s
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Two-column Map Stage: Full Track Overview + Zoomed Corner Line */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left 5 cols: Full Circuit Location Map */}
        <div className="flex flex-col rounded-md border border-[#1B2230] bg-[#090B10] p-3.5 xl:col-span-5">
          <div className="mb-2 flex items-center justify-between text-[11px] font-mono">
            <span className="text-slate-300 font-semibold">{track.name}</span>
            <span className="text-cyan-400">
              {`Focus: Turn ${activeCorner.number}`}
            </span>
          </div>

          <div className="relative flex-1 flex items-center justify-center min-h-[210px]">
            <svg
              viewBox={track.svgViewBox}
              className="h-full max-h-[260px] w-full"
              role="img"
              aria-label={`${track.name} mistake overview map`}
            >
              {/* Asphalt Track Outline */}
              <path
                d={track.svgPath}
                fill="none"
                stroke="#1E2636"
                strokeWidth={14 * overviewDims.scale}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={track.svgPath}
                fill="none"
                stroke="#334155"
                strokeWidth={2 * overviewDims.scale}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Highlighted active corner segment on full map */}
              <path
                d={analysis.asphaltPath}
                fill="none"
                stroke="#22D3EE"
                strokeWidth={10 * overviewDims.scale}
                strokeOpacity={0.38}
                strokeLinecap="round"
              />

              {/* Clickable Corner Pins */}
              {track.corners.map((c) => {
                const comp = comparisonByCornerId.get(c.id);
                const selected = c.id === activeCorner.id;
                const highLoss = (comp?.timeLostSec ?? 0) >= 0.12;
                const r = (selected ? 11 : highLoss ? 8.5 : 6.5) * overviewDims.scale;
                return (
                  <g
                    key={c.id}
                    onClick={() => onSelectCorner(c.id)}
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-label={`Inspect Turn ${c.number} ${c.name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectCorner(c.id);
                      }
                    }}
                  >
                    {selected && (
                      <circle
                        cx={c.mapPoint.x}
                        cy={c.mapPoint.y}
                        r={r * 1.8}
                        fill="#22D3EE"
                        fillOpacity={0.22}
                        stroke="#22D3EE"
                        strokeWidth={1.5 * overviewDims.scale}
                      />
                    )}
                    <circle
                      cx={c.mapPoint.x}
                      cy={c.mapPoint.y}
                      r={r}
                      fill={selected ? '#22D3EE' : highLoss ? '#F43F5E' : '#475569'}
                      stroke="#090B10"
                      strokeWidth={1.8 * overviewDims.scale}
                    />
                    <text
                      x={c.mapPoint.x}
                      y={c.mapPoint.y - r * 1.45}
                      textAnchor="middle"
                      fill={selected ? '#67E8F9' : highLoss ? '#FDA4AF' : '#CBD5E1'}
                      fontSize={16 * overviewDims.scale}
                      fontFamily="monospace"
                      fontWeight={selected || highLoss ? '700' : '600'}
                      paintOrder="stroke"
                      stroke="#090B10"
                      strokeWidth={3.5 * overviewDims.scale}
                    >
                      T{c.number}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-[#1B2230] pt-2 font-mono text-[10px] text-slate-400">
            <span>
              {analysis.traceSource === 'game'
                ? 'Red = your path · Green = correction'
                : 'Red pins = top time-loss corners'}
            </span>
            <span className="text-slate-300">
              {`${analysis.turnDirection.toUpperCase()} turn`}
            </span>
          </div>
        </div>

        {/* Right 7 cols: Zoomed Corner Detail (Red vs Green Line + Brake/Throttle Points) */}
        <div className="flex flex-col rounded-md border border-[#1B2230] bg-[#090B10] p-3.5 xl:col-span-7">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-sm font-bold text-slate-100">
                  {`Zoom: Turn ${activeCorner.number} — ${activeCorner.name}`}
                </span>
                <span
                  className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-300"
                  data-testid="green-line-source-badge"
                >
                  {analysis.greenLineTitle}
                </span>
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400" data-testid="green-line-reason">
                {analysis.greenLineReason}
              </div>
            </div>
            {activeComparison && (
              <div className="rounded border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs font-bold text-emerald-300 tabular-nums">
                Potential gain: -{analysis.changesSummary.timeGainSec.toFixed(2)}s
              </div>
            )}
          </div>

          {/* Zoomed SVG Racing Line */}
          <div className="relative flex-1 rounded border border-[#1B2230] bg-[#07090D] p-1">
            <svg
              viewBox={analysis.zoomViewBox}
              className="h-[285px] w-full"
              data-testid="zoomed-corner-svg"
              role="img"
              aria-label={`Zoomed racing line comparison for Turn ${activeCorner.number}`}
            >
              {/* Crisp Tarmac Polygon (no chunky round-cap distortion) */}
              <path
                d={analysis.roadPolygonPath}
                fill="#141923"
                data-testid="road-polygon"
              />

              {/* Distinct Left & Right Track Border Edges */}
              <path
                d={analysis.leftEdgePath}
                fill="none"
                stroke="#475569"
                strokeWidth={Math.max(0.45, hw * 0.14)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={analysis.rightEdgePath}
                fill="none"
                stroke="#475569"
                strokeWidth={Math.max(0.45, hw * 0.14)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Inside Apex Kerb Strips (Alternating Red & White) */}
              {analysis.kerbPaths.map((kp, idx) => (
                <g key={`kerb-${idx}`}>
                  <path
                    d={kp}
                    fill="none"
                    stroke="#E11D48"
                    strokeWidth={Math.max(0.7, hw * 0.22)}
                    strokeLinecap="butt"
                  />
                  <path
                    d={kp}
                    fill="none"
                    stroke="#F8FAFC"
                    strokeWidth={Math.max(0.7, hw * 0.22)}
                    strokeDasharray={`${hw * 0.55} ${hw * 0.55}`}
                    strokeLinecap="butt"
                  />
                </g>
              ))}

              {/* Subtle Track Centerline */}
              <path
                d={analysis.centerlinePath}
                fill="none"
                stroke="#334155"
                strokeOpacity={0.35}
                strokeWidth={Math.max(0.3, hw * 0.06)}
                strokeDasharray={`${hw * 0.5} ${hw * 0.5}`}
              />

              {/* Perpendicular Braking Threshold Gates Across Tarmac */}
              {analysis.gateLines
                .filter((g) => (g.line === 'green' ? showGreenLine : showRedLine))
                .map((g) => (
                  <line
                    key={g.id}
                    x1={g.x1}
                    y1={g.y1}
                    x2={g.x2}
                    y2={g.y2}
                    stroke={g.line === 'green' ? '#10B981' : '#F43F5E'}
                    strokeOpacity={0.78}
                    strokeWidth={Math.max(0.45, hw * 0.12)}
                    strokeDasharray={`${hw * 0.32} ${hw * 0.22}`}
                    data-testid={`brake-gate-${g.line}`}
                  />
                ))}

              {/* RED LINE: User's actual racing line */}
              {showRedLine && (
                <path
                  d={analysis.userLinePath}
                  fill="none"
                  stroke="#F43F5E"
                  strokeWidth={Math.max(0.75, hw * 0.22)}
                  strokeOpacity={0.95}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={`${hw * 0.6} ${hw * 0.3}`}
                  data-testid="user-red-line"
                />
              )}

              {/* GREEN LINE: Correct Ideal/Pro racing line */}
              {showGreenLine && (
                <path
                  d={analysis.proLinePath}
                  fill="none"
                  stroke="#10B981"
                  strokeWidth={Math.max(0.85, hw * 0.25)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  data-testid="pro-green-line"
                />
              )}

              {/* Brake, Apex, and Throttle Markers with Outward Leader Ticks */}
              {analysis.markers
                .filter((m) => (m.line === 'green' ? showGreenLine : showRedLine))
                .map((m) => {
                  const isGreen = m.line === 'green';
                  const fill = isGreen ? '#10B981' : '#F43F5E';
                  const textFill = isGreen ? '#6EE7B7' : '#FDA4AF';

                  return (
                    <g key={m.id} data-testid={`map-marker-${m.kind}`}>
                      {m.shortLabel && (
                        <line
                          x1={m.x}
                          y1={m.y}
                          x2={m.labelX}
                          y2={m.labelY}
                          stroke={fill}
                          strokeOpacity={0.68}
                          strokeWidth={Math.max(0.35, hw * 0.07)}
                        />
                      )}
                      <circle
                        cx={m.x}
                        cy={m.y}
                        r={markerR * 1.35}
                        fill={fill}
                        fillOpacity={0.22}
                      />
                      {m.kind === 'pro_apex' || m.kind === 'user_apex' ? (
                        <rect
                          x={m.x - markerR * 0.72}
                          y={m.y - markerR * 0.72}
                          width={markerR * 1.44}
                          height={markerR * 1.44}
                          transform={`rotate(45 ${m.x} ${m.y})`}
                          fill={fill}
                          stroke="#07090D"
                          strokeWidth={markerR * 0.28}
                        />
                      ) : (
                        <circle
                          cx={m.x}
                          cy={m.y}
                          r={markerR * 0.85}
                          fill={fill}
                          stroke="#07090D"
                          strokeWidth={markerR * 0.28}
                        />
                      )}
                      {m.shortLabel && (
                        <text
                          x={m.labelX}
                          y={m.labelY}
                          dominantBaseline="middle"
                          textAnchor="middle"
                          fill={textFill}
                          fontSize={labelFontSize}
                          fontFamily="monospace"
                          fontWeight="700"
                          paintOrder="stroke"
                          stroke="#07090D"
                          strokeWidth={labelFontSize * 0.42}
                        >
                          {m.shortLabel}
                        </text>
                      )}
                    </g>
                  );
                })}
            </svg>
            {!showRedLine && !showGreenLine && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded border border-[#1B2230] bg-[#090B10]/90 px-3 py-1.5 font-mono text-[11px] text-slate-300">
                  Turn ON Red or Green line above to compare
                </span>
              </div>
            )}
          </div>

          <CornerDistanceChart report={report} corner={activeCorner} lengthKm={track.lengthKm} />

          {/* Clean Marker Detail Readout Bar */}
          <div className="mt-2 grid grid-cols-1 gap-1.5 font-mono text-[10px] sm:grid-cols-3">
            {analysis.markers
              .filter((m) => m.kind === 'user_brake' || m.kind === 'pro_apex' || m.kind === 'user_throttle')
              .map((m) => {
                const isVisible = m.line === 'green' ? showGreenLine : showRedLine;
                return (
                  <div
                    key={m.id}
                    className={`rounded border border-[#1B2230] bg-[#07090D] px-2.5 py-1.5 leading-snug text-slate-300 transition-opacity ${
                      isVisible ? 'opacity-100' : 'opacity-35'
                    }`}
                    title={m.detailLabel}
                  >
                    <span className={m.line === 'green' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                      {m.kind === 'pro_apex' ? 'APEX: ' : m.kind === 'user_brake' ? 'BRK: ' : 'THR: '}
                    </span>
                    {m.detailLabel}
                  </div>
                );
              })}
          </div>

          {/* Mini Pedal Comparison (Brake & Throttle across Corner) */}
          <div className="mt-2.5 rounded border border-[#1B2230] bg-[#07090D] px-3 py-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-400">
              <span>Corner Pedal Trace (Entry → Apex → Exit)</span>
              <div className="flex items-center gap-3">
                <span className={showGreenLine ? 'text-emerald-400' : 'text-slate-600 line-through'}>
                  ━ {analysis.greenLineTitle} Brake/Throttle
                </span>
                <span className={showRedLine ? 'text-rose-400' : 'text-slate-600 line-through'}>
                  ┄ Your Brake/Throttle
                </span>
              </div>
            </div>
            <svg
              viewBox={`0 0 ${pedalPaths.w} ${pedalPaths.h}`}
              className="h-[58px] w-full"
              role="img"
              aria-label="Corner brake and throttle comparison"
            >
              {/* Pro Brake & Throttle */}
              {showGreenLine && (
                <>
                  <path
                    d={pedalPaths.proBrake}
                    fill="none"
                    stroke="#10B981"
                    strokeWidth="2"
                    strokeOpacity="0.85"
                  />
                  <path
                    d={pedalPaths.proThrottle}
                    fill="none"
                    stroke="#34D399"
                    strokeWidth="2"
                  />
                </>
              )}
              {/* User Brake & Throttle */}
              {showRedLine && (
                <>
                  <path
                    d={pedalPaths.userBrake}
                    fill="none"
                    stroke="#F43F5E"
                    strokeWidth="2"
                    strokeDasharray="4 3"
                  />
                  <path
                    d={pedalPaths.userThrottle}
                    fill="none"
                    stroke="#FB7185"
                    strokeWidth="2"
                    strokeDasharray="3 3"
                  />
                </>
              )}
            </svg>
          </div>
        </div>
      </div>

      {/* Actionable "Changes Needed Here" Strip */}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-rose-300">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            <span>1. Braking Change</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-200">
            {analysis.changesSummary.brakingAction}
          </p>
        </div>

        <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
            <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
            <span>2. Line & Apex Target</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-200">
            {analysis.changesSummary.lineApexAction}
          </p>
        </div>

        <div className="rounded-md border border-[#1B2230] bg-[#090B10] p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            <Zap className="h-3.5 w-3.5" aria-hidden="true" />
            <span>3. Throttle Application</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-200">
            {analysis.changesSummary.throttleAction}
          </p>
          {analysis.changesSummary.setupHint && (
            <div className="mt-1.5 font-mono text-[11px] text-cyan-400">
              Setup: {analysis.changesSummary.setupHint}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
