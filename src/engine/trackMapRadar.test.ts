import test from 'node:test';
import assert from 'node:assert/strict';
import { CARS, TRACKS } from '../data/circuitsAndCars';
import {
  buildPitWallCarRoster,
  computeCarLabelLayouts,
  computeFollowZoomViewBox,
  describeTrackLocation,
  getSectorBoundaries,
  getSectorForPct,
  interpolateTrackPose,
  parseSvgViewBox,
} from './trackMapRadar';
import type { OpponentCar, TelemetryFrame } from '../types/telemetry';

function makeFrame(opponents: OpponentCar[] = [], overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    timestampMs: 50000,
    lapNumber: 4,
    lapDistPct: 0.45,
    speedKmh: 248,
    rpm: 7200,
    maxRpm: 8400,
    gear: 5,
    throttle: 0.92,
    brake: 0,
    steeringRad: 0,
    latG: 0.2,
    longG: 0.3,
    deltaSec: -0.18,
    fuelLiters: 38.4,
    tireTempC: { fl: 86, fr: 86, rl: 83, rr: 83 },
    tirePressurePsi: { fl: 26.6, fr: 26.6, rl: 26.2, rr: 26.2 },
    tireWearPct: { fl: 94, fr: 94, rl: 95, rr: 95 },
    brakeTempC: { fl: 460, fr: 455, rl: 380, rr: 375 },
    frontWheelSlip: 0.03,
    rearWheelSlip: 0.02,
    absActive: false,
    tcActive: false,
    offTrackRisk: 0,
    hazardAhead: false,
    hazardDistanceM: 999,
    hazardDescription: '',
    flagState: 'green',
    playerPosition: 4,
    posX: -412.45,
    posZ: 1084.2,
    opponents,
    ...overrides,
  };
}

test('interpolateTrackPose computes valid SVG coordinates and finite heading angle across full lap', () => {
  const track = TRACKS[0];
  for (let i = 0; i < 20; i++) {
    const pose = interpolateTrackPose(track, i / 20);
    assert.ok(Number.isFinite(pose.x));
    assert.ok(Number.isFinite(pose.y));
    assert.ok(Number.isFinite(pose.headingDeg));
    assert.ok(pose.headingDeg >= -180 && pose.headingDeg <= 180);
  }
});

test('getSectorForPct and getSectorBoundaries split circuit into S1/S2/S3 cleanly', () => {
  const track = TRACKS[0];
  assert.equal(getSectorForPct(0.1), 1);
  assert.equal(getSectorForPct(0.5), 2);
  assert.equal(getSectorForPct(0.85), 3);
  assert.equal(getSectorForPct(0.1, 3), 3);

  const boundaries = getSectorBoundaries(track);
  assert.equal(boundaries.length, 2);
  assert.equal(boundaries[0].label, 'S1/S2');
  assert.equal(boundaries[1].label, 'S2/S3');
});

test('describeTrackLocation resolves Pit Lane, Active Corner, and Straight approaches accurately', () => {
  const track = TRACKS[0];
  const pitLoc = describeTrackLocation(track, 0.02, { inPits: true, speedKmh: 58 });
  assert.match(pitLoc.zoneLabel, /Pit Lane \(58 km\/h\)/);

  const corner = track.corners[0];
  const cornerLoc = describeTrackLocation(track, corner.apexPct);
  assert.equal(cornerLoc.activeCornerNumber, corner.number);
  assert.match(cornerLoc.zoneLabel, new RegExp(`In T${corner.number}`));
  assert.equal(cornerLoc.trackLengthM, Math.round(track.lengthKm * 1000));
});

test('computeFollowZoomViewBox centers and clamps zoomed viewBox inside base bounds', () => {
  const track = TRACKS[0];
  const base = parseSvgViewBox(track.svgViewBox);
  const zoomed = parseSvgViewBox(computeFollowZoomViewBox(track, { x: base.x, y: base.y }, 2.5));
  assert.ok(zoomed.x >= base.x);
  assert.ok(zoomed.y >= base.y);
  assert.ok(zoomed.x + zoomed.w <= base.x + base.w + 0.2);
  assert.ok(zoomed.y + zoomed.h <= base.y + base.h + 0.2);
  assert.ok(Math.abs(zoomed.w - base.w / 2.5) < 1);
});

test('buildPitWallCarRoster preserves legal telemetry details for player and all opponents', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const opponents: OpponentCar[] = [
    {
      id: 'opp-51',
      carNumber: '51',
      driverName: 'A. Pier Guidi',
      carClass: 'Hypercar',
      carName: 'Ferrari 499P',
      lapDistPct: 0.448,
      speedKmh: 274,
      gapSeconds: -0.28,
      distanceMeters: -22,
      closingSpeedKmh: 16,
      lateralSide: 'right',
      isAlongside: false,
      safetyRating: 'aggressive',
      position: 3,
      lapsCompleted: 3,
      inPits: false,
      sector: 2,
      posX: -395.1,
      posZ: 1099.4,
    },
    {
      id: 'opp-pit',
      carNumber: '92',
      driverName: 'K. Estre',
      carClass: 'LMGT3',
      carName: 'Porsche 911 GT3 R',
      lapDistPct: 0.015,
      speedKmh: 60,
      gapSeconds: -24.5,
      distanceMeters: -1800,
      closingSpeedKmh: 0,
      lateralSide: 'center',
      isAlongside: false,
      safetyRating: 'clean',
      position: 14,
      lapsCompleted: 3,
      inPits: true,
    },
  ];

  const roster = buildPitWallCarRoster(makeFrame(opponents), track, car);
  assert.equal(roster.length, 3);
  assert.equal(roster[0].id, 'player');
  assert.equal(roster[0].position, 4);
  assert.equal(roster[0].posX, -412.45);
  assert.equal(roster[0].classShort, 'HY');

  assert.equal(roster[1].carNumber, '51');
  assert.equal(roster[1].status, 'threat');
  assert.equal(roster[1].statusLabel, 'Attacking Behind');
  assert.equal(roster[1].location.sector, 2);
  assert.equal(roster[1].posX, -395.1);

  assert.equal(roster[2].carNumber, '92');
  assert.equal(roster[2].status, 'pit');
  assert.equal(roster[2].statusLabel, 'Pit Lane');
  assert.equal(roster[2].classShort, 'GT3');
});

test('computeCarLabelLayouts separates clustered car labels without overlap inside viewBox', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const clusterPcts = [0.002, 0.998, 0.006, 0.994, 0.01];
  const opponents: OpponentCar[] = clusterPcts.map((pct, i) => ({
    id: `opp-${i}`,
    carNumber: `${50 + i}`,
    driverName: `Driver ${i}`,
    carClass: i === 4 ? 'LMGT3' : 'Hypercar',
    carName: 'Test Car',
    lapDistPct: pct,
    speedKmh: i === 4 ? 60 : 250,
    gapSeconds: (i - 2) * 0.2,
    distanceMeters: (i - 2) * 14,
    closingSpeedKmh: 4,
    lateralSide: 'center',
    isAlongside: false,
    safetyRating: 'clean',
    inPits: i === 4,
  }));

  const roster = buildPitWallCarRoster(makeFrame(opponents, { lapDistPct: 0 }), track, car);
  const layouts = computeCarLabelLayouts(roster, track.svgViewBox, 1, 'player');
  assert.equal(layouts.size, 6);

  const bounds = parseSvgViewBox(track.svgViewBox);
  const boxes = Array.from(layouts.values()).map((l) => {
    const w = l.labelText.length * 6.8 + 6;
    const h = 14;
    const x1 = l.textAnchor === 'middle' ? l.x - w / 2 : l.textAnchor === 'start' ? l.x : l.x - w;
    return { id: l.carId, x1, x2: x1 + w, y1: l.y - h / 2, y2: l.y + h / 2 };
  });

  for (let i = 0; i < boxes.length; i++) {
    assert.ok(boxes[i].x1 >= bounds.x - 0.5);
    assert.ok(boxes[i].x2 <= bounds.x + bounds.w + 0.5);
    assert.ok(boxes[i].y1 >= bounds.y - 0.5);
    assert.ok(boxes[i].y2 <= bounds.y + bounds.h + 0.5);
    for (let j = i + 1; j < boxes.length; j++) {
      const overlaps = !(
        boxes[i].x2 <= boxes[j].x1 ||
        boxes[i].x1 >= boxes[j].x2 ||
        boxes[i].y2 <= boxes[j].y1 ||
        boxes[i].y1 >= boxes[j].y2
      );
      assert.equal(overlaps, false, `Labels ${boxes[i].id} and ${boxes[j].id} should not overlap`);
    }
  }
});
