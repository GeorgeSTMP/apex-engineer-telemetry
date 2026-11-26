import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSessionFromTelemetry } from './autoDetect';

import { TRACKS } from '../data/circuitsAndCars';

test('detectSessionFromTelemetry matches LMU raw track and car names accurately', () => {
  const res = detectSessionFromTelemetry({
    simId: 'Le Mans Ultimate',
    trackName: 'Circuit de Spa-Francorchamps (Endurance)',
    carName: 'AF Corse Ferrari 499P #51',
  });

  assert.equal(res.simId, 'lmu');
  assert.equal(res.track?.id, 'spa');
  assert.equal(res.car?.id, 'ferrari_499p');
  assert.equal(res.trackConfidence, 'alias');
  assert.equal(res.carConfidence, 'alias');
});

test('detectSessionFromTelemetry matches Chevrolet Corvette Z06 LMGT3.R at Bahrain', () => {
  const res = detectSessionFromTelemetry({
    simId: 'lmu',
    trackName: 'Bahrain International Circuit WEC',
    carName: '#33 TF Sport Chevrolet Corvette Z06 LMGT3.R',
    carClass: 'GT3',
  });

  assert.equal(res.simId, 'lmu');
  assert.equal(res.track?.id, 'bahrain');
  assert.equal(res.car?.id, 'corvette_z06_gt3r');
  assert.equal(res.carConfidence, 'alias');
});

test('Bahrain track map starts on the Main Straight and aligns T1 hairpin cleanly', () => {
  const bahrain = TRACKS.find((t) => t.id === 'bahrain')!;
  const p0 = bahrain.pathPoints[0];
  const p1 = bahrain.pathPoints[1];
  const last = bahrain.pathPoints[bahrain.pathPoints.length - 1];
  const v1x = p0.x - last.x;
  const v1y = p0.y - last.y;
  const v2x = p1.x - p0.x;
  const v2y = p1.y - p0.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  const sfAngleDeg = (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
  assert.ok(sfAngleDeg < 5, `Start/Finish line must be on a straight, got ${sfAngleDeg}deg`);
  // Main straight heads UP (smaller y) on the left side toward Turn 1 at top-left
  assert.ok(p1.y < p0.y && p0.x < 120);
  const t1 = bahrain.corners.find((c) => c.number === 1)!;
  assert.ok(t1.mapPoint.y < 80 && t1.mapPoint.x < 120);
});

test('detectSessionFromTelemetry falls back to track length and car class/RPM when names are generic', () => {
  const res = detectSessionFromTelemetry({
    simId: 'acc',
    trackName: 'Unknown Custom Folder',
    trackLengthKm: 5.79,
    carName: 'Lamborghini Huracan GT3 EVO2',
    maxRpm: 8500,
  });

  assert.equal(res.simId, 'acc');
  assert.equal(res.track?.id, 'monza');
  assert.equal(res.trackConfidence, 'length');
  assert.equal(res.car?.carClass, 'LMGT3');
  assert.equal(res.carConfidence, 'class_rpm');
});

test('detectSessionFromTelemetry matches accented and abbreviated track names', () => {
  const res = detectSessionFromTelemetry({
    trackName: 'Autódromo do Algarve',
    carName: 'Oreca 07 Gibson LMP2',
  });

  assert.equal(res.track?.id, 'portimao');
  assert.equal(res.car?.id, 'oreca_07_lmp2');
});

test('detectSessionFromTelemetry accurately resolves all 12 official LMU alternate layouts', () => {
  const cases: Array<{ trackName: string; trackLengthKm?: number; expectedId: string }> = [
    { trackName: 'Circuit de la Sarthe No Chicanes', expectedId: 'lemans_mulsanne' },
    { trackName: 'Bahrain International Circuit Outer', expectedId: 'bahrain_outer' },
    { trackName: 'Bahrain International Circuit', trackLengthKm: 3.823, expectedId: 'bahrain_paddock' },
    { trackName: 'Autodromo Nazionale Monza Curva Grande', expectedId: 'monza_curva_grande' },
    { trackName: 'Sebring International Raceway School', expectedId: 'sebring_school' },
    { trackName: 'Fuji Speedway Classic', expectedId: 'fuji_classic' },
    { trackName: 'Circuit of the Americas National', expectedId: 'cota_national' },
    { trackName: 'Lusail International Circuit', trackLengthKm: 3.701, expectedId: 'lusail_short' },
    { trackName: 'Silverstone Circuit National', expectedId: 'silverstone_national' },
    { trackName: 'Silverstone Circuit International', expectedId: 'silverstone_international' },
    { trackName: 'Circuit Paul Ricard 1C-V2', expectedId: 'paul_ricard_1c_v2' },
    { trackName: 'Circuit Paul Ricard 3A Short', expectedId: 'paul_ricard_3a' },
  ];

  for (const c of cases) {
    const res = detectSessionFromTelemetry({
      simId: 'lmu',
      trackName: c.trackName,
      trackLengthKm: c.trackLengthKm,
    });
    assert.equal(res.track?.id, c.expectedId, `Failed on "${c.trackName}"`);
  }
});

test('all 30 circuits place Start/Finish on a straight and align every Turn onto a real bend within svgViewBox', () => {
  assert.equal(TRACKS.length, 30);

  for (const track of TRACKS) {
    const [vx, vy, vw, vh] = track.svgViewBox.split(' ').map(Number);
    const pts = track.pathPoints;
    assert.ok(pts.length >= 60, `${track.id} needs >= 60 path points`);

    // Verify Start/Finish line P0 sits on a clean straight segment
    const p0 = pts[0];
    const p1 = pts[1];
    const last = pts[pts.length - 1];
    const v1x = p0.x - last.x;
    const v1y = p0.y - last.y;
    const v2x = p1.x - p0.x;
    const v2y = p1.y - p0.y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    const sfAngleDeg =
      mag > 0 ? (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / mag))) * 180) / Math.PI : 0;
    assert.ok(sfAngleDeg < 8, `${track.id} Start/Finish P0 angle too sharp: ${sfAngleDeg.toFixed(1)}deg`);

    // Verify every corner's mapPoint is inside svgViewBox and near a genuine bend
    for (const corner of track.corners) {
      assert.ok(
        corner.mapPoint.x >= vx - 2 &&
          corner.mapPoint.x <= vx + vw + 2 &&
          corner.mapPoint.y >= vy - 2 &&
          corner.mapPoint.y <= vy + vh + 2,
        `${track.id} T${corner.number} mapPoint out of viewBox`
      );

      const idx = Math.min(pts.length - 1, Math.max(0, Math.round(corner.apexPct * (pts.length - 1))));
      // Measure cumulative directional change around apexPct (+/- 4 vertices)
      let bendDeg = 0;
      for (let k = -3; k <= 3; k++) {
        const i0 = (idx + k - 1 + pts.length) % pts.length;
        const i1 = (idx + k + pts.length) % pts.length;
        const i2 = (idx + k + 1 + pts.length) % pts.length;
        const ax = pts[i1].x - pts[i0].x;
        const ay = pts[i1].y - pts[i0].y;
        const bx = pts[i2].x - pts[i1].x;
        const by = pts[i2].y - pts[i1].y;
        const m = Math.hypot(ax, ay) * Math.hypot(bx, by);
        if (m > 0) {
          bendDeg += (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / m))) * 180) / Math.PI;
        }
      }
      assert.ok(
        bendDeg >= 10,
        `${track.id} T${corner.number} (${corner.name}) apexPct=${corner.apexPct} sits on a flat straight (bend=${bendDeg.toFixed(1)}deg)`
      );
    }
  }
});
