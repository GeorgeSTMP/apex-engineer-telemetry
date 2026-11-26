import type { HardwareInputMapping, HardwareInputState } from '../types/telemetry';

export const DEFAULT_STANDARD_MAPPING: HardwareInputMapping = {
  steeringAxis: 0,
  throttleAxis: null,
  brakeAxis: null,
  clutchAxis: null,
  throttleButton: 7, // RT / R2
  brakeButton: 6, // LT / L2
  clutchButton: null,
  invertThrottle: false,
  invertBrake: false,
  invertClutch: false,
  invertSteering: false,
  throttleRestValue: 0,
  brakeRestValue: 0,
  clutchRestValue: 0,
  gearUpButton: 5, // RB / R1
  gearDownButton: 4, // LB / L1
  pttButton: 0, // A / Cross
  steeringMaxDeg: 270,
};

export const DEFAULT_WHEEL_MAPPING: HardwareInputMapping = {
  steeringAxis: 0,
  throttleAxis: 1,
  brakeAxis: 2,
  clutchAxis: 3,
  throttleButton: null,
  brakeButton: null,
  clutchButton: null,
  invertThrottle: true,
  invertBrake: true,
  invertClutch: true,
  invertSteering: false,
  throttleRestValue: 1,
  brakeRestValue: 1,
  clutchRestValue: 1,
  gearUpButton: 4,
  gearDownButton: 5,
  pttButton: 0,
  steeringMaxDeg: 450,
};

export const EMPTY_HARDWARE_STATE: HardwareInputState = {
  connected: false,
  deviceId: null,
  deviceName: null,
  isStandardMapping: false,
  sourceKind: 'none',
  steeringNormalized: 0,
  steeringDeg: 0,
  throttle: 0,
  brake: 0,
  clutch: 0,
  gearUpPressed: false,
  gearDownPressed: false,
  pttPressed: false,
  axes: [],
  pressedButtons: [],
};

export function createInitialMappingForGamepad(gamepad: Gamepad): HardwareInputMapping {
  if (gamepad.mapping === 'standard') {
    return { ...DEFAULT_STANDARD_MAPPING };
  }
  const axesCount = gamepad.axes.length;
  return {
    ...DEFAULT_WHEEL_MAPPING,
    throttleAxis: axesCount > 2 ? 2 : axesCount > 1 ? 1 : null,
    brakeAxis: axesCount > 5 ? 5 : axesCount > 1 ? 1 : null,
    clutchAxis: axesCount > 6 ? 6 : axesCount > 3 ? 3 : null,
    throttleRestValue: gamepad.axes[axesCount > 2 ? 2 : 1] ?? 1,
    brakeRestValue: gamepad.axes[axesCount > 5 ? 5 : 1] ?? 1,
    clutchRestValue: gamepad.axes[axesCount > 6 ? 6 : 3] ?? 1,
  };
}

export function normalizePedalAxis(
  rawValue: number | undefined,
  restValue: number,
  invert: boolean
): number {
  if (rawValue === undefined || !Number.isFinite(rawValue)) return 0;

  // If resting near +1 or -1, map full range [-1, 1] -> [0, 1]
  if (Math.abs(restValue) > 0.5) {
    const travel = restValue > 0 ? (restValue - rawValue) / 2 : (rawValue - restValue) / 2;
    const clamped = Math.max(0, Math.min(1, travel));
    return clamped < 0.02 ? 0 : clamped;
  }

  // Resting near 0: either [0..1] or [0..-1]
  const val = invert ? -rawValue : rawValue;
  const clamped = Math.max(0, Math.min(1, val));
  return clamped < 0.02 ? 0 : clamped;
}

export function readGamepadHardwareState(
  gamepad: Gamepad,
  mapping: HardwareInputMapping
): HardwareInputState {
  const axes = Array.from(gamepad.axes, (a) => Math.round(a * 1000) / 1000);
  const pressedButtons: number[] = [];
  gamepad.buttons.forEach((btn, idx) => {
    if (btn.pressed || btn.value > 0.5) pressedButtons.push(idx);
  });

  const rawSteer = axes[mapping.steeringAxis] ?? 0;
  const steerDeadzone = Math.abs(rawSteer) < 0.02 ? 0 : rawSteer;
  const steeringNormalized = Math.max(
    -1,
    Math.min(1, mapping.invertSteering ? -steerDeadzone : steerDeadzone)
  );
  const steeringDeg = Math.round(steeringNormalized * (mapping.steeringMaxDeg / 2));

  let throttle = 0;
  if (mapping.throttleButton !== null && gamepad.buttons[mapping.throttleButton]) {
    throttle = gamepad.buttons[mapping.throttleButton].value;
  } else if (mapping.throttleAxis !== null) {
    throttle = normalizePedalAxis(
      axes[mapping.throttleAxis],
      mapping.throttleRestValue,
      mapping.invertThrottle
    );
  }

  let brake = 0;
  if (mapping.brakeButton !== null && gamepad.buttons[mapping.brakeButton]) {
    brake = gamepad.buttons[mapping.brakeButton].value;
  } else if (mapping.brakeAxis !== null) {
    brake = normalizePedalAxis(
      axes[mapping.brakeAxis],
      mapping.brakeRestValue,
      mapping.invertBrake
    );
  }

  let clutch = 0;
  if (mapping.clutchButton !== null && gamepad.buttons[mapping.clutchButton]) {
    clutch = gamepad.buttons[mapping.clutchButton].value;
  } else if (mapping.clutchAxis !== null) {
    clutch = normalizePedalAxis(
      axes[mapping.clutchAxis],
      mapping.clutchRestValue,
      mapping.invertClutch
    );
  }

  const gearUpPressed =
    mapping.gearUpButton !== null && Boolean(gamepad.buttons[mapping.gearUpButton]?.pressed);
  const gearDownPressed =
    mapping.gearDownButton !== null && Boolean(gamepad.buttons[mapping.gearDownButton]?.pressed);
  const pttPressed =
    mapping.pttButton !== null && Boolean(gamepad.buttons[mapping.pttButton]?.pressed);

  return {
    connected: gamepad.connected,
    deviceId: `${gamepad.index}`,
    deviceName: gamepad.id || `Controller #${gamepad.index + 1}`,
    isStandardMapping: gamepad.mapping === 'standard',
    sourceKind: 'gamepad',
    steeringNormalized,
    steeringDeg,
    throttle: Math.round(throttle * 100) / 100,
    brake: Math.round(brake * 100) / 100,
    clutch: Math.round(clutch * 100) / 100,
    gearUpPressed,
    gearDownPressed,
    pttPressed,
    axes,
    pressedButtons,
  };
}

export function detectBestGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return null;
  }
  const pads = navigator.getGamepads();
  const connected: Gamepad[] = [];
  for (const pad of pads) {
    if (pad && pad.connected) connected.push(pad);
  }
  if (connected.length === 0) return null;

  // Prefer wheel / pedal devices by name if multiple gamepads exist
  const wheelPad = connected.find((p) =>
    /wheel|fanatec|logitech|g29|g920|g923|thrustmaster|t300|t248|tgt|moza|simagic|simucube|heusinkveld|pedal|direct drive/i.test(
      p.id
    )
  );
  return wheelPad ?? connected[0];
}
