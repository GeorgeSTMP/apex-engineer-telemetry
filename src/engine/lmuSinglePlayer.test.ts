import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findLmuPlayerVehicle,
  isLmuInPitOrGarage,
  isLmuPaused,
  isTruthySimFlag,
} from './lmuSinglePlayer';

test('isTruthySimFlag handles booleans, numbers, and REST strings', () => {
  assert.equal(isTruthySimFlag(true), true);
  assert.equal(isTruthySimFlag(1), true);
  assert.equal(isTruthySimFlag('1'), true);
  assert.equal(isTruthySimFlag('true'), true);
  assert.equal(isTruthySimFlag(false), false);
  assert.equal(isTruthySimFlag(0), false);
  assert.equal(isTruthySimFlag('NONE'), false);
});

test('findLmuPlayerVehicle selects single car in Solo Practice even without player boolean', () => {
  const soloVehicles = [
    {
      slotID: 0,
      vehicleName: 'Porsche 963 LMDh',
      player: false,
      focus: false,
      speedKmh: 215,
    },
  ];
  const player = findLmuPlayerVehicle(soloVehicles);
  assert.ok(player);
  assert.equal(player?.vehicleName, 'Porsche 963 LMDh');
});

test('findLmuPlayerVehicle prioritizes explicit player over focused AI car in Single Player Race vs AI', () => {
  const aiRaceVehicles = [
    { slotID: 1, vehicleName: 'Ferrari 499P AI', player: 0, focus: true, controlType: 'AI' },
    { slotID: 4, vehicleName: 'Porsche 963 Player', player: 1, focus: false, controlType: 'PLAYER' },
  ];
  const player = findLmuPlayerVehicle(aiRaceVehicles);
  assert.equal(player?.vehicleName, 'Porsche 963 Player');
});

test('isLmuInPitOrGarage avoids false pit status on benign pitState strings and detects Single Player pause', () => {
  const onTrackCar = {
    inGarageStall: false,
    inPits: false,
    pitState: 'NO_PIT',
    focus: true,
  };
  assert.equal(isLmuInPitOrGarage(onTrackCar, 240, { gamePhase: 'GREEN' }), false);

  // Single Player ESC pause
  assert.equal(isLmuPaused({ gamePhase: 'PAUSED' }), true);
  assert.equal(isLmuInPitOrGarage(onTrackCar, 0, { gamePhase: 'PAUSED' }), true);

  // Explicit garage/pit state
  assert.equal(
    isLmuInPitOrGarage({ pitState: 'IN_GARAGE' }, 0, { gamePhase: 'GREEN' }),
    true
  );
});
