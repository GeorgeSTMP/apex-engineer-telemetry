import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, CARS, buildReferenceLap, buildSampleUserLap } from '../data/circuitsAndCars';
import { buildPostRaceReport } from './raceReport';
import { buildDebriefPresentationDeck } from './debriefSlides';

test('buildDebriefPresentationDeck produces chronological overview, corner, and summary slides', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);

  const report = buildPostRaceReport({
    simId: 'lmu',
    simName: 'Le Mans Ultimate',
    track,
    car,
    setup: car.defaultSetup,
    driverProfile: {
      driverName: 'Test Driver',
      skillTier: 'developing',
      isNewToGame: false,
      primaryGoal: 'pace',
      habits: {
        lapsAnalyzed: 5,
        lateBrakeCount: 3,
        lockupCount: 1,
        exitSnapCount: 2,
        offTrackCount: 0,
        avgTrailBrakeScore: 71,
        avgDeltaSec: 1.6,
        brakingConsistencyPct: 86,
      },
      learnedStrengths: [],
      learnedWeaknesses: [],
    },
    laps: [sampleLap],
    referenceSamples: ref,
    mistakeCounts: { lateBrakes: 3, lockups: 1, exitSnaps: 2, offTracks: 0 },
    sessionMode: 'practice_stint',
    language: 'en',
  });

  const deck = buildDebriefPresentationDeck({
    report,
    track,
    car,
    referenceSamples: ref,
    language: 'en',
  });

  assert.ok(deck.length >= 4, `Expected overview + corner slides + summary, got ${deck.length}`);
  assert.equal(deck[0].kind, 'overview');
  assert.equal(deck[deck.length - 1].kind, 'summary');

  const cornerSlides = deck.filter((s) => s.kind === 'corner');
  assert.ok(cornerSlides.length >= 2);
  for (let i = 1; i < cornerSlides.length; i++) {
    assert.ok(
      (cornerSlides[i].cornerNumber ?? 0) >= (cornerSlides[i - 1].cornerNumber ?? 0),
      'Corner slides should walk chronologically in ascending turn order'
    );
  }
  for (const cs of cornerSlides) {
    assert.ok(cs.cornerAnalysis, 'Each corner slide must attach cornerAnalysis map geometry');
    assert.ok(cs.wentRight.length >= 1, 'Each slide must note what went right');
    assert.ok(cs.wentWrong.length >= 1, 'Each slide must note what went wrong');
    assert.ok(cs.howToFix.length >= 1, 'Each slide must provide concrete fixes');
    assert.ok(cs.narrationText.length > 20, 'Each slide must provide voice narration script');
  }
});

test('buildDebriefPresentationDeck generates full English narration and uses AI brief when provided', () => {
  const track = TRACKS.find((t) => t.id === 'spa') ?? TRACKS[0];
  const car = CARS[1] ?? CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);

  const report = buildPostRaceReport({
    simId: 'lmu',
    simName: 'Le Mans Ultimate',
    track,
    car,
    setup: car.defaultSetup,
    driverProfile: {
      driverName: 'Driver EN',
      skillTier: 'competitive',
      isNewToGame: false,
      primaryGoal: 'pace',
      habits: {
        lapsAnalyzed: 4,
        lateBrakeCount: 2,
        lockupCount: 0,
        exitSnapCount: 1,
        offTrackCount: 1,
        avgTrailBrakeScore: 80,
        avgDeltaSec: 1.1,
        brakingConsistencyPct: 90,
      },
      learnedStrengths: [],
      learnedWeaknesses: [],
    },
    laps: [sampleLap],
    referenceSamples: ref,
    mistakeCounts: { lateBrakes: 2, lockups: 0, exitSnaps: 1, offTracks: 1 },
    sessionMode: 'live_race',
    language: 'en',
  });

  const deck = buildDebriefPresentationDeck({
    report,
    track,
    car,
    referenceSamples: ref,
    aiBrief: {
      headline: 'Strong pace at Spa — +3 positions within reach on braking',
      executiveSummary: 'Consistent line through Raidillon while losing time on La Source entry.',
      watchOutFor: [{ title: 'La Source', detail: 'Commit to throttle earlier after the hairpin apex.' }],
      actionPlan: [{ step: 'Turn 1', howToFix: 'Brake 8m earlier at the board.', expectedGainSec: 0.25 }],
      positionGainVerdict: 'You gain 3 positions across the race.',
      spokenSummary: 'Great consistency through the fast sectors, tidy up Turn 1 for a podium fight.',
    },
    language: 'en',
  });

  assert.equal(deck[0].title, 'Strong pace at Spa — +3 positions within reach on braking');
  assert.match(deck[0].narrationText, /Spa|Raidillon|La Source/i);
  assert.match(deck[deck.length - 1].narrationText, /gain 3 positions/i);
});

test('buildDebriefPresentationDeck stays strictly English even if a legacy report contains stored Greek strings', () => {
  const track = TRACKS.find((t) => t.id === 'lemans')!;
  const car = CARS[0];
  const ref = buildReferenceLap(track, car);
  const sampleLap = buildSampleUserLap(track, car);

  const baseReport = buildPostRaceReport({
    simId: 'lmu',
    simName: 'Le Mans Ultimate',
    track,
    car,
    setup: car.defaultSetup,
    driverProfile: {
      driverName: 'Driver Legacy',
      skillTier: 'developing',
      isNewToGame: false,
      primaryGoal: 'pace',
      habits: {
        lapsAnalyzed: 4,
        lateBrakeCount: 2,
        lockupCount: 1,
        exitSnapCount: 1,
        offTrackCount: 0,
        avgTrailBrakeScore: 76,
        avgDeltaSec: 0.9,
        brakingConsistencyPct: 87,
      },
      learnedStrengths: [],
      learnedWeaknesses: [],
    },
    laps: [sampleLap],
    referenceSamples: ref,
    mistakeCounts: { lateBrakes: 2, lockups: 1, exitSnaps: 1, offTracks: 0 },
    sessionMode: 'practice_stint',
    language: 'en',
  });

  const legacyGreekSample = '\u0391\u03C1\u03B3\u03B5\u03AF\u03C2 \u03C3\u03C4\u03BF \u03B3\u03BA\u03AC\u03B6\u03B9';
  const legacyReportWithGreek = {
    ...baseReport,
    mistakeFixes: baseReport.mistakeFixes.map((fix, idx) =>
      idx === 0
        ? {
            ...fix,
            mistakeTitle: legacyGreekSample,
            watchOutDetail: legacyGreekSample,
            howToFix: legacyGreekSample,
          }
        : fix
    ),
  };

  const deckEn = buildDebriefPresentationDeck({
    report: legacyReportWithGreek,
    track,
    car,
    referenceSamples: ref,
    aiBrief: {
      headline: legacyGreekSample,
      executiveSummary: legacyGreekSample,
      watchOutFor: [{ title: legacyGreekSample, detail: legacyGreekSample }],
      actionPlan: [{ step: legacyGreekSample, howToFix: legacyGreekSample, expectedGainSec: 0.2 }],
      positionGainVerdict: legacyGreekSample,
      spokenSummary: legacyGreekSample,
    },
    language: 'en',
  });

  const greekRegex = /[\u0370-\u03FF\u1F00-\u1FFF]/;
  for (const slide of deckEn) {
    assert.equal(
      greekRegex.test(slide.narrationText),
      false,
      `Narration on ${slide.id} should not contain Greek characters: ${slide.narrationText}`
    );
    for (const w of slide.wentWrong) {
      assert.equal(
        greekRegex.test(w),
        false,
        `wentWrong on ${slide.id} should not contain Greek characters: ${w}`
      );
    }
  }
});
