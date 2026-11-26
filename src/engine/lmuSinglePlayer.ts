export type SessionGridMode = 'grid' | 'solo';

export function isTruthySimFlag(val: unknown): boolean {
  if (val === true || val === 1) return true;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

/**
 * Finds the player's vehicle in LMU `/rest/watch/standings` across Multiplayer,
 * Single Player Race Weekend (vs AI), and Single Player Solo Practice / Hotlap.
 */
export function findLmuPlayerVehicle(
  vehicles: Array<Record<string, unknown>>,
  focusSlotId?: string | number | null
): Record<string, unknown> | undefined {
  if (!Array.isArray(vehicles) || vehicles.length === 0) {
    return undefined;
  }

  // 1. Explicit player / local human driver markers (handles booleans, numbers, strings, controlType)
  const explicitPlayer = vehicles.find((v) => {
    if (
      isTruthySimFlag(v.player) ||
      isTruthySimFlag(v.isPlayer) ||
      isTruthySimFlag(v.localPlayer)
    ) {
      return true;
    }
    const ctrl = String(v.controlType ?? v.control ?? '').trim().toUpperCase();
    return ctrl === 'PLAYER' || ctrl === 'HUMAN' || ctrl === 'LOCAL';
  });
  if (explicitPlayer) {
    return explicitPlayer;
  }

  // 2. Single-car session (Single Player Solo Practice / Hotlap / Private Test)
  if (vehicles.length === 1) {
    return vehicles[0];
  }

  // 3. Explicit focus slot fallback when player flag is omitted by REST build
  if (focusSlotId !== undefined && focusSlotId !== null && String(focusSlotId).trim() !== '') {
    const focusMatch = vehicles.find(
      (v) => v.slotID !== undefined && String(v.slotID) === String(focusSlotId)
    );
    if (focusMatch) return focusMatch;
  }

  const focused = vehicles.find((v) => isTruthySimFlag(v.focus));
  if (focused) {
    return focused;
  }

  return undefined;
}

const EXPLICIT_PIT_STATES = new Set([
  'IN_PITS',
  'IN_GARAGE',
  'GARAGE',
  'PITTING',
  'PIT_LANE',
  'PIT',
  'ENTERING',
  'EXITING',
  'STOPPED',
  'REQUESTED',
  'SERVING',
]);

/**
 * Determines whether the player car is paused in Single Player or physically in pits/garage.
 * Avoids false-positives on benign pitState strings like "NO_PIT", "OUT", "NONE", or "0".
 */
export function isLmuPaused(
  sessionInfo?: Record<string, unknown> | null,
  gameState?: Record<string, unknown> | null
): boolean {
  const phase = String(
    sessionInfo?.gamePhase ?? gameState?.gamePhase ?? gameState?.state ?? ''
  )
    .trim()
    .toUpperCase();
  return (
    phase.includes('PAUSE') ||
    isTruthySimFlag(sessionInfo?.paused) ||
    isTruthySimFlag(sessionInfo?.isPaused) ||
    isTruthySimFlag(gameState?.paused)
  );
}

export function isLmuInPitOrGarage(
  player: Record<string, unknown>,
  speedKmh: number,
  sessionInfo?: Record<string, unknown> | null,
  gameState?: Record<string, unknown> | null
): boolean {
  if (
    isTruthySimFlag(player.inGarageStall) ||
    isTruthySimFlag(player.inGarage) ||
    isTruthySimFlag(player.inPits) ||
    isTruthySimFlag(player.pitting)
  ) {
    return true;
  }

  const pitStateStr =
    typeof player.pitState === 'string' ? player.pitState.trim().toUpperCase() : '';
  if (pitStateStr && EXPLICIT_PIT_STATES.has(pitStateStr)) {
    return true;
  }

  if (isLmuPaused(sessionInfo, gameState)) {
    return true;
  }

  // Stationary off-focus car in monitor/garage
  if (speedKmh < 1.2 && player.focus === false) {
    return true;
  }

  return false;
}
