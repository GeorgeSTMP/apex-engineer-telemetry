import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, CARS, buildReferenceLap, buildSampleUserLap } from '../data/circuitsAndCars';
import { analyzeLapByCorners } from './coachRules';
import { createDefaultDriverProfile } from './driverLearning';
import {
  buildCornerLineAnalysis,
  classifyCornerArchetype,
  interpolateTrackPointPct,
  solveRealisticRacingLine,
} from './racingLine';

test('interpolateTrackPointPct returns finite coordinates across full [0, 1) lap including wrap-around', () => {
  const lemans = TRACKS.find((t) => t.id === 'lemans')!;
  for (const pct of [0, 0.08, 0.49, 0.99, 1.02, -0.02]) {
    const pt = interpolateTrackPointPct(lemans, pct);
    assert.ok(Number.isFinite(pt.x), `x should be finite at pct=${pct}`);
    assert.ok(Number.isFinite(pt.y), `y should be finite at pct=${pct}`);
  }
});

test('buildCornerLineAnalysis generates distinct Red (user) and Green (pro) SVG paths and brake/throttle markers', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);
  const comparisons = analyzeLapByCorners(sampleLap.frames, ref, track);

  const corner = track.corners[0]; // Dunlop Bridge & Chicane (late brake / lockup in sample)
  const comp = comparisons.find((c) => c.cornerId === corner.id) ?? null;

  const analysis = buildCornerLineAnalysis({
    track,
    car,
    corner,
    comparison: comp,
    referenceSamples: ref,
    driverFrames: sampleLap.frames,
    language: 'en',
  });

  assert.ok(analysis.asphaltPath.startsWith('M '));
  assert.ok(analysis.roadPolygonPath.startsWith('M ') && analysis.roadPolygonPath.endsWith('Z'));
  assert.ok(analysis.leftEdgePath.startsWith('M '));
  assert.ok(analysis.rightEdgePath.startsWith('M '));
  assert.ok(analysis.trackHalfWidth > 0 && analysis.trackHalfWidth <= 8.5, `Expected sleek trackHalfWidth <= 8.5, got ${analysis.trackHalfWidth}`);
  assert.ok(analysis.gateLines.length >= 1, 'Expected at least green braking gate line');
  assert.ok(analysis.proLinePath.startsWith('M '));
  assert.ok(analysis.userLinePath.startsWith('M '));
  assert.notEqual(
    analysis.proLinePath,
    analysis.userLinePath,
    'User red line and Pro green line must diverge when a mistake exists'
  );

  // Verify zoomViewBox parses to 4 positive/finite numbers
  const vbParts = analysis.zoomViewBox.split(' ').map(Number);
  assert.equal(vbParts.length, 4);
  assert.ok(vbParts[2] > 0 && vbParts[3] > 0);

  // Verify all 6 required markers exist with finite coordinates
  const kinds = new Set(analysis.markers.map((m) => m.kind));
  assert.ok(kinds.has('pro_brake'));
  assert.ok(kinds.has('user_brake'));
  assert.ok(kinds.has('pro_apex'));
  assert.ok(kinds.has('user_apex'));
  assert.ok(kinds.has('pro_throttle'));
  assert.ok(kinds.has('user_throttle'));
  for (const m of analysis.markers) {
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y));
  }

  assert.ok(analysis.pedalComparison.length >= 20);
  assert.ok(analysis.changesSummary.brakingAction.length > 10);
  assert.ok(analysis.changesSummary.throttleAction.length > 10);
});

test('buildCornerLineAnalysis supports English coaching copy and works across all 30 LMU circuits', () => {
  const car = CARS[0];
  for (const track of TRACKS) {
    const ref = buildReferenceLap(track, car);
    const corner = track.corners[0];
    const analysis = buildCornerLineAnalysis({
      track,
      car,
      corner,
      comparison: {
        cornerId: corner.id,
        cornerNumber: corner.number,
        cornerName: corner.name,
        sector: corner.sector,
        brakingDeltaMeters: 11,
        entrySpeedDeltaKmh: 9,
        minApexSpeedDeltaKmh: -6,
        exitSpeedDeltaKmh: -5,
        trailBrakingScore: 68,
        timeLostSec: 0.24,
        primaryIssue: 'Braked late & delayed exit throttle',
      },
      referenceSamples: ref,
      language: 'en',
    });

    assert.ok(analysis.roadPolygonPath.endsWith('Z'), `roadPolygonPath missing Z for ${track.id}`);
    assert.ok(analysis.leftEdgePath.length > 12, `leftEdgePath missing for ${track.id}`);
    assert.ok(analysis.rightEdgePath.length > 12, `rightEdgePath missing for ${track.id}`);
    assert.ok(analysis.trackHalfWidth <= 8.5, `trackHalfWidth too thick for ${track.id}: ${analysis.trackHalfWidth}`);
    assert.ok(analysis.gateLines.length === 2, `expected both green & red gateLines for 11m delta on ${track.id}`);
    assert.ok(analysis.proLinePath.length > 12, `proLinePath missing for ${track.id}`);
    assert.ok(analysis.userLinePath.length > 12, `userLinePath missing for ${track.id}`);
    assert.match(analysis.changesSummary.brakingAction, /Brake|Carry|Keep/i);
    assert.match(analysis.changesSummary.throttleAction, /throttle/i);
    assert.equal(analysis.traceSource, 'schematic');
  }
});

test('buildCornerLineAnalysis switches to real world posX/posZ trace when telemetry includes world coordinates', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const corner = track.corners[0];

  // Generate 16 real-world points along a 90-degree bend across the corner window
  const rawSpan = Math.max(0.022, corner.exitPct - corner.startPct);
  const startPct = corner.startPct - 0.015;
  const totalPct = rawSpan + 0.03;
  const driverFrames = Array.from({ length: 16 }, (_, idx) => {
    const u = idx / 15;
    const angle = u * (Math.PI / 2);
    return {
      lapDistPct: ((startPct + u * totalPct) % 1 + 1) % 1,
      speedKmh: 160 - Math.sin(angle) * 55,
      throttle: u > 0.65 ? 0.9 : 0.05,
      brake: u > 0.2 && u < 0.5 ? 0.8 : 0,
      steeringRad: 0.25,
      frontWheelSlip: 0.05,
      rearWheelSlip: 0.04,
      posX: Math.sin(angle) * 65,
      posZ: -(1 - Math.cos(angle)) * 65,
    };
  });

  const analysis = buildCornerLineAnalysis({
    track,
    car,
    corner,
    comparison: {
      cornerId: corner.id,
      cornerNumber: corner.number,
      cornerName: corner.name,
      sector: corner.sector,
      brakingDeltaMeters: 9,
      entrySpeedDeltaKmh: 6,
      minApexSpeedDeltaKmh: -4,
      exitSpeedDeltaKmh: -4,
      trailBrakingScore: 70,
      timeLostSec: 0.18,
      primaryIssue: 'Braked late into apex',
    },
    referenceSamples: ref,
    driverFrames,
    language: 'en',
  });

  assert.equal(analysis.traceSource, 'game');
  assert.equal(analysis.trackHalfWidth, 6);
  assert.notEqual(analysis.proLinePath, analysis.userLinePath);
  assert.match(analysis.changesSummary.lineApexAction, /You ran wide/i);
});

test('classifyCornerArchetype and solveRealisticRacingLine produce outside braking -> late apex -> track-out shape', () => {
  const lemans = TRACKS.find((t) => t.id === 'lemans')!;
  const hairpinCorner = {
    ...lemans.corners[0],
    name: 'Mulsanne Hairpin',
    targetApexSpeedKmh: 62,
  };
  const n = 78;
  const rels = Array.from({ length: n }, (_, i) => (i / (n - 1)) * 0.05);
  const hairpinKappa = rels.map((_, i) => {
    const u = i / (n - 1);
    return Math.exp(-Math.pow((u - 0.5) / 0.16, 2)) * 0.35;
  });
  const sCurveKappa = rels.map((_, i) => {
    const u = i / (n - 1);
    return Math.sin(u * Math.PI * 2) * 0.28;
  });
  const sweeperCorner = {
    ...lemans.corners[0],
    name: 'Porsche Curves',
    targetApexSpeedKmh: 185,
  };
  const sweeperKappa = rels.map((_, i) => {
    const u = i / (n - 1);
    return Math.exp(-Math.pow((u - 0.5) / 0.25, 2)) * 0.22;
  });

  assert.equal(classifyCornerArchetype(hairpinKappa, hairpinCorner), 'hairpin');
  assert.equal(classifyCornerArchetype(sCurveKappa, hairpinCorner), 'chicane');
  assert.equal(classifyCornerArchetype(sweeperKappa, sweeperCorner), 'sweeper');

  const solved = solveRealisticRacingLine({
    smoothKappa: hairpinKappa,
    rels,
    brakeRel: 0.014,
    apexRel: 0.025,
    windowTotalPct: 0.05,
    primaryInsideSign: 1,
    archetype: 'hairpin',
    maxLat: 0.85,
  });

  assert.equal(solved.length, n);
  // Pre-turn-in entry stays toward outside (-1 side), apex pulls strongly toward inside (+1 side), exit tracks back outside
  const entryAvg = (solved[6] + solved[10] + solved[14]) / 3;
  const apexRegionMax = Math.max(...solved.slice(32, 52));
  const exitTail = solved[n - 3];
  assert.ok(entryAvg < 0, `Expected outside braking entry (< 0), got ${entryAvg}`);
  assert.ok(apexRegionMax > 0.3, `Expected strong inside apex clip (> 0.3), got ${apexRegionMax}`);
  assert.ok(exitTail < apexRegionMax, 'Exit must track out away from inside apex');
});

test('buildCornerLineAnalysis differentiates Pro vs Learned Green lines and projects player proven_best world path', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const corner = track.corners[0];

  const newcomer = createDefaultDriverProfile(true);
  const newcomerWithHabits = {
    ...newcomer,
    habits: { ...newcomer.habits, lockupCount: 3, exitSnapCount: 2, lateBrakeCount: 3 },
  };
  const comparison = {
    cornerId: corner.id,
    cornerNumber: corner.number,
    cornerName: corner.name,
    sector: corner.sector,
    brakingDeltaMeters: 8,
    entrySpeedDeltaKmh: 5,
    minApexSpeedDeltaKmh: -5,
    exitSpeedDeltaKmh: -4,
    trailBrakingScore: 66,
    timeLostSec: 0.22,
    primaryIssue: 'Braked late & exit snap',
  };

  const proAnalysis = buildCornerLineAnalysis({
    track,
    car,
    corner,
    comparison,
    referenceSamples: ref,
    driverProfile: newcomerWithHabits,
    greenLineMode: 'pro',
    language: 'en',
  });
  const learnedAnalysis = buildCornerLineAnalysis({
    track,
    car,
    corner,
    comparison,
    referenceSamples: ref,
    driverProfile: newcomerWithHabits,
    greenLineMode: 'learned',
    language: 'en',
  });

  assert.equal(proAnalysis.greenLineSource, 'pro');
  assert.equal(learnedAnalysis.greenLineSource, 'learned');
  assert.notEqual(proAnalysis.proLinePath, learnedAnalysis.proLinePath, 'Learned Green line should adapt from Pro line for newcomer');

  const proBrake = proAnalysis.markers.find((m) => m.kind === 'pro_brake')!;
  const learnedBrake = learnedAnalysis.markers.find((m) => m.kind === 'pro_brake')!;
  assert.ok(learnedBrake.pct !== proBrake.pct || learnedBrake.detailLabel !== proBrake.detailLabel);

  // Now verify world-coordinate proven_best pass projection
  const rawSpan = Math.max(0.022, corner.exitPct - corner.startPct);
  const startPct = corner.startPct - 0.015;
  const totalPct = rawSpan + 0.03;

  const currentDriven = Array.from({ length: 16 }, (_, idx) => {
    const u = idx / 15;
    const angle = u * (Math.PI / 2);
    return {
      lapDistPct: ((startPct + u * totalPct) % 1 + 1) % 1,
      speedKmh: 150 - Math.sin(angle) * 55,
      throttle: u > 0.68 ? 0.85 : 0.05,
      brake: u > 0.2 && u < 0.5 ? 0.85 : 0,
      steeringRad: 0.25,
      frontWheelSlip: 0.05,
      rearWheelSlip: 0.04,
      posX: Math.sin(angle) * 68,
      posZ: -(1 - Math.cos(angle)) * 68,
    };
  });
  const fasterBestPass = Array.from({ length: 16 }, (_, idx) => {
    const u = idx / 15;
    const angle = u * (Math.PI / 2);
    return {
      lapDistPct: ((startPct + u * totalPct) % 1 + 1) % 1,
      speedKmh: 164 - Math.sin(angle) * 48,
      throttle: u > 0.56 ? 0.95 : 0.1,
      brake: u > 0.18 && u < 0.44 ? 0.78 : 0,
      steeringRad: 0.21,
      frontWheelSlip: 0.03,
      rearWheelSlip: 0.03,
      posX: Math.sin(angle) * 62.5,
      posZ: -(1 - Math.cos(angle)) * 62.5,
    };
  });

  const bestPassAnalysis = buildCornerLineAnalysis({
    track,
    car,
    corner,
    comparison,
    referenceSamples: ref,
    driverFrames: currentDriven,
    bestCornerPassFrames: fasterBestPass,
    bestCornerPassTimeSec: 3.85,
    driverProfile: newcomerWithHabits,
    greenLineMode: 'auto',
    language: 'en',
  });

  assert.equal(bestPassAnalysis.traceSource, 'game');
  assert.equal(bestPassAnalysis.greenLineSource, 'proven_best');
  assert.notEqual(bestPassAnalysis.proLinePath, bestPassAnalysis.userLinePath);
});


