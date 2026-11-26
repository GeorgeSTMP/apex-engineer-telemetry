import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, CARS, buildReferenceLap, buildSampleUserLap } from '../data/circuitsAndCars';
import {
  FULL_LAP_DOMAIN,
  computeCornerZoomDomain,
  computeDeltaTraceSeries,
  findNearestIndexByPct,
  projectPctToSvgX,
  sampleReferencePedalAtPct,
  svgRatioToPct,
} from './telemetryWorkbook';

test('computeCornerZoomDomain expands corner window with padding and enforces min span', () => {
  const track = TRACKS[0];
  const corner = track.corners[0];
  const domain = computeCornerZoomDomain(corner, 0.03, 0.08);
  assert.equal(domain.isZoomed, true);
  assert.ok(domain.minPct >= 0);
  assert.ok(domain.maxPct <= 1);
  assert.ok(domain.spanPct >= 0.08 - 1e-9);
  assert.ok(domain.minPct <= corner.startPct);
  assert.ok(domain.maxPct >= corner.exitPct);

  const full = computeCornerZoomDomain(null);
  assert.deepEqual(full, FULL_LAP_DOMAIN);
});

test('projectPctToSvgX and svgRatioToPct invert cleanly across zoomed domains', () => {
  const track = TRACKS[0];
  const corner = track.corners[2] ?? track.corners[0];
  const domain = computeCornerZoomDomain(corner);
  const width = 960;
  const targetPct = corner.apexPct;
  const x = projectPctToSvgX(targetPct, domain, width);
  assert.ok(x >= 0 && x <= width);
  const roundTrip = svgRatioToPct(x / width, domain);
  assert.ok(Math.abs(roundTrip - targetPct) < 1e-6);
});

test('sampleReferencePedalAtPct interpolates reference throttle/brake cleanly', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const mid = sampleReferencePedalAtPct(ref, 0.5);
  assert.ok(mid.throttle >= 0 && mid.throttle <= 1);
  assert.ok(mid.brake >= 0 && mid.brake <= 1);
  assert.ok(mid.speedKmh > 40);

  const clampedLow = sampleReferencePedalAtPct(ref, -0.5);
  assert.equal(clampedLow.speedKmh, ref[0].speedKmh);
});

test('computeDeltaTraceSeries builds aligned Delta-T trace for both live delta and zero-delta laps', () => {
  const track = TRACKS[0];
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);

  const series = computeDeltaTraceSeries(sampleLap.frames, ref, track.lengthKm);
  assert.equal(series.points.length, sampleLap.frames.length);
  assert.ok(series.maxAbsDeltaSec >= 0.35);

  const flatDeltaFrames = sampleLap.frames.map((f) => ({ ...f, deltaSec: 0 }));
  const derivedSeries = computeDeltaTraceSeries(flatDeltaFrames, ref, track.lengthKm);
  assert.equal(derivedSeries.points.length, flatDeltaFrames.length);
  const anyNonZero = derivedSeries.points.some((p) => Math.abs(p.deltaSec) > 0.001);
  assert.equal(anyNonZero, true);
});

test('findNearestIndexByPct locates closest frame by track distance', () => {
  const items = [{ lapDistPct: 0.1 }, { lapDistPct: 0.25 }, { lapDistPct: 0.52 }, { lapDistPct: 0.9 }];
  assert.equal(findNearestIndexByPct(items, 0.24), 1);
  assert.equal(findNearestIndexByPct(items, 0.55), 2);
  assert.equal(findNearestIndexByPct([], 0.5), -1);
});
