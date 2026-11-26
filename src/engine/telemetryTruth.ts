import type {
  CornerDefinition,
  SimConnectionStatus,
  TelemetryFrame,
  TrackProfile,
} from '../types/telemetry';

export type SessionTruthStatus =
  | 'standby_offline'
  | 'game_in_menus'
  | 'in_garage_or_pits'
  | 'on_track_live'
  | 'practice_demo';

export type TelemetryIncidentType = 'crash_impact' | 'spin' | 'off_track' | 'lockup';

export interface TelemetryIncident {
  id: string;
  type: TelemetryIncidentType;
  cornerNumber: number | null;
  cornerName: string;
  lapNumber: number;
  speedKmh: number;
  impactDeltaKmh?: number;
  timestampMs: number;
}

export interface ParsedDriverClaim {
  claimedType: TelemetryIncidentType | null;
  claimedTurnNumber: number | null;
  matchedCornerName: string | null;
}

export type ClaimTruthStatus =
  | 'confirmed'
  | 'contradicted_not_playing'
  | 'contradicted_in_garage'
  | 'contradicted_no_incident'
  | 'neutral';

export interface CoachRealityCheckResult {
  sessionStatus: SessionTruthStatus;
  truthStatus: ClaimTruthStatus;
  contradicted: boolean;
  claimedIncident: ParsedDriverClaim;
  matchingIncidents: TelemetryIncident[];
  recentIncidents: TelemetryIncident[];
  groundTruthBrief: string;
  truthFallbackReply: string | null;
}

const WORD_TO_NUM: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export function resolveSessionTruthStatus(params: {
  externalStreamActive: boolean;
  isLiveRunning: boolean;
  simStatus: SimConnectionStatus;
  frame?: Pick<TelemetryFrame, 'inPitOrGarage' | 'speedKmh'>;
}): SessionTruthStatus {
  const { externalStreamActive, isLiveRunning, simStatus, frame } = params;

  if (externalStreamActive) {
    if (simStatus.connectionState === 'in_pit' || frame?.inPitOrGarage) {
      return 'in_garage_or_pits';
    }
    return 'on_track_live';
  }

  if (simStatus.gameRunning) {
    if (simStatus.connectionState === 'in_pit' || frame?.inPitOrGarage) {
      return 'in_garage_or_pits';
    }
    if (simStatus.connectionState === 'on_track') {
      return 'on_track_live';
    }
    if (!isLiveRunning) {
      return 'game_in_menus';
    }
  }

  if (isLiveRunning) {
    return 'practice_demo';
  }

  return 'standby_offline';
}

export function detectTelemetryIncident(params: {
  nextFrame: TelemetryFrame;
  prevFrame: TelemetryFrame | null;
  track: TrackProfile;
  activeCorner: CornerDefinition | null;
  isDrivingSession: boolean;
  nowMs?: number;
}): Omit<TelemetryIncident, 'id'> | null {
  const { nextFrame, prevFrame, track, activeCorner, isDrivingSession } = params;
  if (!isDrivingSession || nextFrame.inPitOrGarage) {
    return null;
  }

  const nowMs = params.nowMs ?? nextFrame.timestampMs ?? Date.now();
  const corner = activeCorner ?? track.corners[0] ?? null;
  const cornerNumber = corner ? corner.number : null;
  const cornerName = corner ? `Turn ${corner.number} (${corner.name})` : 'On Track';

  if (prevFrame) {
    const dtSec = Math.max(0.05, Math.min(2.0, (nowMs - prevFrame.timestampMs) / 1000));
    const speedDrop = prevFrame.speedKmh - nextFrame.speedKmh;
    const decelSpikeCrash = speedDrop >= 55 && dtSec <= 0.65 && nextFrame.longG <= -2.8;
    const hardWallImpact = nextFrame.longG <= -3.6 && prevFrame.speedKmh >= 45;

    if (decelSpikeCrash || hardWallImpact) {
      return {
        type: 'crash_impact',
        cornerNumber,
        cornerName,
        lapNumber: nextFrame.lapNumber,
        speedKmh: Math.round(nextFrame.speedKmh),
        impactDeltaKmh: Math.round(Math.max(0, speedDrop)),
        timestampMs: nowMs,
      };
    }
  }

  if (nextFrame.offTrackRisk >= 0.72 && nextFrame.speedKmh >= 20) {
    return {
      type: 'off_track',
      cornerNumber,
      cornerName,
      lapNumber: nextFrame.lapNumber,
      speedKmh: Math.round(nextFrame.speedKmh),
      timestampMs: nowMs,
    };
  }

  if (nextFrame.rearWheelSlip >= 0.34 && (Math.abs(nextFrame.steeringRad) >= 0.28 || nextFrame.speedKmh < 110)) {
    return {
      type: 'spin',
      cornerNumber,
      cornerName,
      lapNumber: nextFrame.lapNumber,
      speedKmh: Math.round(nextFrame.speedKmh),
      timestampMs: nowMs,
    };
  }

  if (nextFrame.frontWheelSlip >= 0.25 && nextFrame.brake >= 0.45 && nextFrame.speedKmh >= 40) {
    return {
      type: 'lockup',
      cornerNumber,
      cornerName,
      lapNumber: nextFrame.lapNumber,
      speedKmh: Math.round(nextFrame.speedKmh),
      timestampMs: nowMs,
    };
  }

  return null;
}

export function parseDriverIncidentClaim(
  question: string,
  track?: TrackProfile
): ParsedDriverClaim {
  const q = question.toLowerCase().trim();

  let claimedType: ParsedDriverClaim['claimedType'] = null;
  if (
    /\b(crash(?:ed|ing)?|wreck(?:ed)?|smashed|collid(?:ed|e|ing)|collision|binned it|hit (?:the )?(?:wall|barrier|armco|tire|tyre|car)|into the (?:wall|barrier))\b/.test(
      q
    )
  ) {
    claimedType = 'crash_impact';
  } else if (/\b(spun|spin(?:ning)? out|looped it|lost the rear|spun out)\b/.test(q)) {
    claimedType = 'spin';
  } else if (/\b(went off|off[- ]track|in the (?:gravel|sand|grass)|ran wide into)\b/.test(q)) {
    claimedType = 'off_track';
  } else if (/\b(lock(?:ed)? up|lockup|flat[- ]?spot)\b/.test(q)) {
    claimedType = 'lockup';
  }

  let claimedTurnNumber: number | null = null;
  const numMatch =
    q.match(/(?:\bturn|\bt)\s*#?\s*(\d{1,2})\b/i) ??
    q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+turn\b/i);
  if (numMatch?.[1]) {
    const parsed = Number.parseInt(numMatch[1], 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 30) {
      claimedTurnNumber = parsed;
    }
  } else {
    const wordMatch = q.match(
      /(?:\bturn\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third)|\b(first|second|third|fourth|fifth)\s+turn\b)/i
    );
    const matchedWord = (wordMatch?.[1] ?? wordMatch?.[2] ?? '').toLowerCase();
    if (matchedWord && WORD_TO_NUM[matchedWord]) {
      claimedTurnNumber = WORD_TO_NUM[matchedWord];
    }
  }

  let matchedCornerName: string | null = null;
  if (track) {
    for (const corner of track.corners) {
      const cname = corner.name.toLowerCase();
      if (cname.length >= 4 && q.includes(cname)) {
        matchedCornerName = corner.name;
        if (claimedTurnNumber === null) {
          claimedTurnNumber = corner.number;
        }
        break;
      }
      if (claimedTurnNumber !== null && corner.number === claimedTurnNumber) {
        matchedCornerName = corner.name;
      }
    }
  }

  return {
    claimedType,
    claimedTurnNumber,
    matchedCornerName,
  };
}

function formatClaimTarget(claim: ParsedDriverClaim): string {
  if (claim.claimedTurnNumber !== null) {
    const suffix = claim.matchedCornerName ? ` (${claim.matchedCornerName})` : '';
    return `Turn ${claim.claimedTurnNumber}${suffix}`;
  }
  return 'on track';
}

function describeIncidentType(type: TelemetryIncidentType): string {
  switch (type) {
    case 'crash_impact':
      return 'crash or impact';
    case 'spin':
      return 'spin';
    case 'off_track':
      return 'off-track excursion';
    case 'lockup':
      return 'wheel lockup';
  }
}

export function evaluateCoachRealityCheck(params: {
  question: string;
  language?: 'en';
  externalStreamActive: boolean;
  isLiveRunning: boolean;
  simStatus: SimConnectionStatus;
  sessionType?: string;
  frame: TelemetryFrame;
  track: TrackProfile;
  activeCorner: CornerDefinition | null;
  upcomingCorner: CornerDefinition;
  incidents: TelemetryIncident[];
  nowMs?: number;
}): CoachRealityCheckResult {
  const {
    question,
    externalStreamActive,
    isLiveRunning,
    simStatus,
    frame,
    track,
    activeCorner,
    upcomingCorner,
    incidents,
  } = params;

  const nowMs = params.nowMs ?? Date.now();
  const sessionStatus = resolveSessionTruthStatus({
    externalStreamActive,
    isLiveRunning,
    simStatus,
    frame,
  });

  const recentIncidents = incidents
    .filter((inc) => nowMs - inc.timestampMs <= 180000)
    .slice(0, 8);

  const claimedIncident = parseDriverIncidentClaim(question, track);
  const matchingIncidents = claimedIncident.claimedType
    ? recentIncidents.filter((inc) => {
        if (inc.type !== claimedIncident.claimedType) return false;
        if (claimedIncident.claimedTurnNumber !== null && inc.cornerNumber !== null) {
          return inc.cornerNumber === claimedIncident.claimedTurnNumber;
        }
        return true;
      })
    : [];

  let truthStatus: ClaimTruthStatus = 'neutral';
  let truthFallbackReply: string | null = null;
  const speedRounded = Math.round(frame.speedKmh);
  const currentLocationLabel =
    sessionStatus === 'standby_offline'
      ? 'Standby / Game NOT running (0 km/h, no live telemetry)'
      : sessionStatus === 'game_in_menus'
        ? `${simStatus.gameName ?? 'Simulator'} open in Menus / Pre-session (0 km/h, not driving)`
        : sessionStatus === 'in_garage_or_pits'
          ? `In Garage / Pit Stall (${speedRounded} km/h, not racing on track)`
          : sessionStatus === 'practice_demo'
            ? `Practice Demo loop at ${
                activeCorner
                  ? `Turn ${activeCorner.number} (${activeCorner.name})`
                  : `approaching Turn ${upcomingCorner.number} (${upcomingCorner.name})`
              } (${speedRounded} km/h, Lap ${frame.lapNumber})`
            : `Live Simulator On Track at ${
                activeCorner
                  ? `Turn ${activeCorner.number} (${activeCorner.name})`
                  : `approaching Turn ${upcomingCorner.number} (${upcomingCorner.name})`
              } (${speedRounded} km/h, Lap ${frame.lapNumber})`;

  if (claimedIncident.claimedType) {
    const incidentWords = describeIncidentType(claimedIncident.claimedType);
    const targetWords = formatClaimTarget(claimedIncident);

    if (sessionStatus === 'standby_offline' || sessionStatus === 'game_in_menus') {
      truthStatus = 'contradicted_not_playing';
      truthFallbackReply =
        sessionStatus === 'game_in_menus'
          ? `Checking live telemetry — ${simStatus.gameName ?? 'the simulator'} is open in the Menus at 0 km/h, not out on track, so there is no ${incidentWords} at ${targetWords}. Load into a track session or start Practice Demo first.`
          : `Checking live telemetry — you aren't playing the game right now (Standby / Simulator offline, 0 km/h, zero telemetry). No ${incidentWords} occurred at ${targetWords}; launch the sim or hit Practice Demo for live data.`;
    } else if (sessionStatus === 'in_garage_or_pits') {
      truthStatus = 'contradicted_in_garage';
      truthFallbackReply = `Telemetry shows the car is sitting in the Garage / Pit Stall (${speedRounded} km/h), not out at ${targetWords}, with zero ${incidentWords} recorded. Roll out onto the circuit when you're ready.`;
    } else if (matchingIncidents.length > 0) {
      truthStatus = 'confirmed';
    } else {
      truthStatus = 'contradicted_no_incident';
      const whereNow = activeCorner
        ? `Turn ${activeCorner.number} (${activeCorner.name})`
        : `approaching Turn ${upcomingCorner.number} (${upcomingCorner.name})`;

      truthFallbackReply = `Checking the telemetry logs: there is no ${incidentWords} recorded at ${targetWords}. You are on Lap ${frame.lapNumber} (${whereNow}) at ${speedRounded} km/h with no impact or incident spike detected.`;
    }
  } else if (sessionStatus === 'standby_offline' || sessionStatus === 'game_in_menus') {
    truthFallbackReply =
      sessionStatus === 'game_in_menus'
        ? `${simStatus.gameName ?? 'The simulator'} is currently open in the Menus (0 km/h). Load into the garage or head out on track and I will read live telemetry immediately.`
        : `Pit wall is in Standby — the simulator is not running right now (0 km/h, no live session). Launch the game or start Practice Demo so I can read real telemetry.`;
  } else if (sessionStatus === 'in_garage_or_pits') {
    truthFallbackReply = `You are currently in the Garage / Pit Stall at ${track.name} (${speedRounded} km/h). Dial in your baseline setup and roll out onto the circuit when you're ready.`;
  }

  const incidentSummaryText =
    recentIncidents.length > 0
      ? recentIncidents
          .map(
            (inc) =>
              `${inc.type} at ${inc.cornerName} on Lap ${inc.lapNumber} (${Math.max(
                0,
                Math.round((nowMs - inc.timestampMs) / 1000)
              )}s ago, ${inc.speedKmh} km/h)`
          )
          .join('; ')
      : 'NONE (zero crashes, spins, off-tracks, or lockups recorded)';

  const groundTruthBrief = [
    `SESSION_STATUS=${sessionStatus}`,
    `SESSION_PHASE=${params.sessionType ?? simStatus.sessionType ?? 'unknown'}`,
    `GAME_RUNNING=${simStatus.gameRunning}`,
    `CONNECTION_STATE=${simStatus.connectionState}`,
    `EXTERNAL_TELEMETRY_ACTIVE=${externalStreamActive}`,
    `PRACTICE_DEMO_ACTIVE=${!externalStreamActive && isLiveRunning}`,
    `LOCATION=${currentLocationLabel}`,
    `LAP_DIST_PCT=${(frame.lapDistPct * 100).toFixed(1)}%`,
    `RECORDED_INCIDENTS=${incidentSummaryText}`,
    `CLAIM_CHECK=${truthStatus}${
      claimedIncident.claimedType
        ? ` (driver mentioned ${claimedIncident.claimedType}${
            claimedIncident.claimedTurnNumber ? ` at Turn ${claimedIncident.claimedTurnNumber}` : ''
          })`
        : ''
    }`,
  ].join(' | ');

  return {
    sessionStatus,
    truthStatus,
    contradicted:
      truthStatus === 'contradicted_not_playing' ||
      truthStatus === 'contradicted_in_garage' ||
      truthStatus === 'contradicted_no_incident',
    claimedIncident,
    matchingIncidents,
    recentIncidents,
    groundTruthBrief,
    truthFallbackReply,
  };
}
