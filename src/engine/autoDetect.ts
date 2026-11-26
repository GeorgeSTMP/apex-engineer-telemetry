import { CARS, SIM_GAMES, TRACKS } from '../data/circuitsAndCars';
import type { CarProfile, SimGameId, TelemetryFrame, TrackProfile } from '../types/telemetry';

export interface TelemetrySessionMetadata {
  simId?: string | null;
  simName?: string | null;
  trackId?: string | null;
  trackName?: string | null;
  trackLengthKm?: number | null;
  carId?: string | null;
  carName?: string | null;
  carClass?: string | null;
  maxRpm?: number | null;
}

export interface AutoDetectedSession {
  simId: SimGameId | null;
  track: TrackProfile | null;
  car: CarProfile | null;
  rawSimName: string | null;
  rawTrackName: string | null;
  rawCarName: string | null;
  trackConfidence: 'exact' | 'alias' | 'length' | 'none';
  carConfidence: 'exact' | 'alias' | 'class_rpm' | 'none';
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SIM_ALIASES: Record<SimGameId, string[]> = {
  lmu: ['lmu', 'le mans ultimate', 'lemansultimate', 'motorsport games lmu'],
  acc: ['acc', 'assetto corsa competizione', 'competizione'],
  iracing: ['iracing', 'irsdk', 'i racing'],
  rf2: ['rf2', 'rfactor 2', 'rfactor2'],
};

const TRACK_ALIASES: Record<string, string[]> = {
  lemans: [
    'lemans',
    'le mans',
    'sarthe',
    'circuit de la sarthe',
    'circuitdes24heures',
    'circuit des 24 heures',
    'le mans gp',
    'sarthe 24h',
  ],
  lemans_mulsanne: [
    'lemans mulsanne',
    'le mans mulsanne',
    'mulsanne no chicanes',
    'no chicanes',
    'sarthe no chicanes',
    'circuit de la sarthe mulsanne',
    'circuit de la sarthe no chicanes',
    'le mans classic straight',
  ],
  portimao: ['portimao', 'algarve', 'autodromo do algarve'],
  spa: ['spa', 'francorchamps', 'spa francorchamps'],
  monza: ['monza', 'autodromo nazionale monza', 'autodromo nazionale di monza'],
  monza_curva_grande: [
    'monza curva grande',
    'curva grande',
    'monza no first chicane',
    'monza no chicane',
    'autodromo nazionale monza curva grande',
  ],
  sebring: ['sebring', 'sebring international', 'sebring gp'],
  sebring_school: ['sebring school', 'sebring international raceway school', 'sebring short'],
  bahrain: ['bahrain', 'sakhir', 'bahrain international', 'bahrain wec', 'bahrain endurance', 'bahrain gp'],
  bahrain_outer: ['bahrain outer', 'bahrain international circuit outer', 'bahrain international outer', 'sakhir outer'],
  bahrain_paddock: ['bahrain paddock', 'bahrain international circuit paddock', 'bahrain international paddock', 'sakhir paddock'],
  fuji: ['fuji', 'fuji speedway', 'oyama', 'fuji gp'],
  fuji_classic: ['fuji classic', 'fuji speedway classic', 'fuji no chicane', 'fuji classic no chicane'],
  imola: ['imola', 'enzo e dino ferrari', 'autodromo enzo'],
  cota: ['cota', 'circuit of the americas', 'americas', 'austin', 'cota gp'],
  cota_national: ['cota national', 'circuit of the americas national', 'americas national'],
  interlagos: ['interlagos', 'jose carlos pace', 'sao paulo'],
  lusail: ['lusail', 'losail', 'qatar', 'lusail gp'],
  lusail_short: ['lusail short', 'losail short', 'qatar short', 'lusail international circuit short'],
  silverstone: ['silverstone', 'silverstone gp', 'silverstone grand prix'],
  silverstone_national: ['silverstone national', 'silverstone circuit national'],
  silverstone_international: ['silverstone international', 'silverstone circuit international'],
  paul_ricard: ['paul ricard', 'paulricard', 'castellet', 'le castellet', 'paul ricard 1a v2', '1a v2'],
  paul_ricard_1c_v2: [
    'paul ricard 1c v2',
    'paul ricard 1c',
    '1c v2',
    'north chicane',
    'mistral chicane',
    'paul ricard north chicane',
  ],
  paul_ricard_3a: ['paul ricard 3a', '3a short', 'paul ricard 3a short', 'paul ricard short'],
  barcelona: ['barcelona', 'catalunya', 'montmelo'],
  daytona: ['daytona', 'daytona road', 'daytona international'],
  laguna_seca: ['laguna seca', 'laguna', 'weathertech raceway'],
  road_atlanta: ['road atlanta', 'braselton', 'michelin raceway road atlanta'],
  long_beach: ['long beach', 'streets of long beach'],
};

const CAR_ALIASES: Record<string, string[]> = {
  porsche_963: ['porsche 963', '963 lmdh', '963', 'penske 963', 'hertz team jota', 'jota 963', 'proton competition 963'],
  ferrari_499p: ['ferrari 499p', '499p', '499 p', 'af corse 499', 'af corse 50', 'af corse 51', 'af corse 83'],
  toyota_gr010: ['toyota gr010', 'gr010', 'toyota gazoo', 'gazoo racing 7', 'gazoo racing 8'],
  cadillac_vseries_r: ['cadillac v series', 'cadillac vseries', 'v series r', 'cadillac racing', 'whelen'],
  bmw_m_hybrid_v8: ['bmw m hybrid', 'hybrid v8', 'bmw m team wrt', 'wrt 15', 'wrt 20'],
  corvette_z06_gt3r: ['corvette z06', 'z06 lmgt3', 'z06 gt3', 'chevrolet corvette', 'tf sport 33', 'tf sport 81', 'tf sport 82', 'corvette'],
  ferrari_296_gt3: ['ferrari 296', '296 lmgt3', '296 gt3', 'vista af corse', 'af corse 54', 'af corse 55', 'af corse 21'],
  aston_martin_gt3: ['aston martin vantage', 'vantage amr lmgt3', 'vantage gt3', 'heart of racing', 'dstation', 'd station'],
  bmw_m4_gt3: ['bmw m4', 'm4 lmgt3', 'm4 gt3', 'team wrt 31', 'team wrt 46'],
  ford_mustang_gt3: ['ford mustang', 'mustang lmgt3', 'mustang gt3', 'proton competition 77', 'proton competition 88'],
  mclaren_720s_gt3: ['mclaren 720s', '720s lmgt3', '720s gt3', 'united autosports 59', 'united autosports 95'],
  lexus_rcf_gt3: ['lexus rc f', 'lexus rcf', 'rc f lmgt3', 'rc f gt3', 'akkodis asp', 'akkodis'],
  porsche_911_gt3r: ['porsche 911 gt3 r', '911 gt3 r', '992 gt3', 'gt3 r 992', 'porsche gt3', 'manthey'],
  oreca_07_lmp2: ['oreca 07', 'oreca07', 'oreca gibson', 'oreca', 'lmp2'],
};

export function matchSimGame(rawSim?: string | null): SimGameId | null {
  if (!rawSim) return null;
  const norm = normalizeToken(rawSim);
  if (!norm) return null;

  const direct = SIM_GAMES.find((s) => s.id === norm);
  if (direct) return direct.id;

  for (const [simId, aliases] of Object.entries(SIM_ALIASES) as Array<[SimGameId, string[]]>) {
    if (aliases.some((alias) => norm === alias || norm.includes(alias))) {
      return simId;
    }
  }
  return null;
}

export function matchTrackProfile(
  rawTrackName?: string | null,
  rawTrackId?: string | null,
  rawTrackLengthKm?: number | null
): { track: TrackProfile | null; confidence: AutoDetectedSession['trackConfidence'] } {
  const idNorm = rawTrackId ? normalizeToken(rawTrackId) : '';
  if (idNorm) {
    const byId = TRACKS.find((t) => normalizeToken(t.id) === idNorm);
    if (byId) return { track: byId, confidence: 'exact' };
  }

  const hasValidLength =
    typeof rawTrackLengthKm === 'number' &&
    Number.isFinite(rawTrackLengthKm) &&
    rawTrackLengthKm > 1;

  const nameNorm = rawTrackName ? normalizeToken(rawTrackName) : '';
  if (nameNorm) {
    const exactName = TRACKS.find((t) => normalizeToken(t.name) === nameNorm);
    if (
      exactName &&
      (!hasValidLength || Math.abs(exactName.lengthKm - (rawTrackLengthKm as number)) <= 0.18)
    ) {
      return { track: exactName, confidence: 'exact' };
    }

    interface AliasCandidate {
      track: TrackProfile;
      score: number;
      lengthDiff: number;
    }
    const candidates: AliasCandidate[] = [];

    for (const track of TRACKS) {
      const aliases = TRACK_ALIASES[track.id] ?? [normalizeToken(track.id)];
      let bestAliasScore = -1;
      for (const alias of aliases) {
        if (nameNorm === alias) {
          bestAliasScore = Math.max(bestAliasScore, 1000 + alias.length);
        } else if (nameNorm.includes(alias)) {
          bestAliasScore = Math.max(bestAliasScore, alias.length);
        }
      }
      if (bestAliasScore > 0) {
        const lengthDiff = hasValidLength
          ? Math.abs(track.lengthKm - (rawTrackLengthKm as number))
          : 0;
        candidates.push({ track, score: bestAliasScore, lengthDiff });
      }
    }

    if (candidates.length > 0) {
      if (hasValidLength) {
        const nearLength = candidates.filter((c) => c.lengthDiff <= 0.09);
        if (nearLength.length > 0) {
          nearLength.sort((a, b) => b.score - a.score || a.lengthDiff - b.lengthDiff);
          return { track: nearLength[0].track, confidence: 'alias' };
        }
      }
      candidates.sort((a, b) => b.score - a.score || a.lengthDiff - b.lengthDiff);
      const top = candidates[0];
      if (hasValidLength && top.lengthDiff > 0.18) {
        const baseKey = top.track.id.split('_')[0];
        const familyMatch = TRACKS.filter(
          (t) => t.id === baseKey || t.id.startsWith(`${baseKey}_`)
        )
          .map((t) => ({ track: t, diff: Math.abs(t.lengthKm - (rawTrackLengthKm as number)) }))
          .sort((a, b) => a.diff - b.diff)[0];
        if (familyMatch && familyMatch.diff <= 0.12) {
          return { track: familyMatch.track, confidence: 'alias' };
        }
      }
      return { track: top.track, confidence: 'alias' };
    }
  }

  if (hasValidLength) {
    let bestTrack: TrackProfile | null = null;
    let bestDiff = Infinity;
    for (const track of TRACKS) {
      const diff = Math.abs(track.lengthKm - (rawTrackLengthKm as number));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestTrack = track;
      }
    }
    if (bestTrack && bestDiff <= 0.16) {
      return { track: bestTrack, confidence: 'length' };
    }
  }

  return { track: null, confidence: 'none' };
}

export function matchCarProfile(
  rawCarName?: string | null,
  rawCarId?: string | null,
  rawCarClass?: string | null,
  rawMaxRpm?: number | null
): { car: CarProfile | null; confidence: AutoDetectedSession['carConfidence'] } {
  const idNorm = rawCarId ? normalizeToken(rawCarId) : '';
  if (idNorm) {
    const byId = CARS.find((c) => normalizeToken(c.id) === idNorm);
    if (byId) return { car: byId, confidence: 'exact' };
  }

  const nameNorm = rawCarName ? normalizeToken(rawCarName) : '';
  if (nameNorm) {
    const exactName = CARS.find((c) => normalizeToken(c.name) === nameNorm);
    if (exactName) return { car: exactName, confidence: 'exact' };

    for (const car of CARS) {
      const aliases = CAR_ALIASES[car.id] ?? [normalizeToken(car.name)];
      if (aliases.some((alias) => nameNorm.includes(alias))) {
        return { car, confidence: 'alias' };
      }
    }

    // Class hints inside raw car string (e.g. "BMW M Hybrid V8" -> Hypercar, "Aston Martin Vantage AMR LMGT3" -> LMGT3)
    if (nameNorm.includes('gt3') || nameNorm.includes('lmgt3') || nameNorm.includes('gte')) {
      const gt3 = CARS.find((c) => c.carClass === 'LMGT3');
      if (gt3) return { car: gt3, confidence: 'class_rpm' };
    }
    if (nameNorm.includes('lmp2') || nameNorm.includes('gibson')) {
      const lmp2 = CARS.find((c) => c.carClass === 'LMP2');
      if (lmp2) return { car: lmp2, confidence: 'class_rpm' };
    }
    if (nameNorm.includes('hypercar') || nameNorm.includes('lmdh') || nameNorm.includes('lmh')) {
      const hyper = CARS.find((c) => c.carClass === 'Hypercar');
      if (hyper) return { car: hyper, confidence: 'class_rpm' };
    }
  }

  const classNorm = rawCarClass ? normalizeToken(rawCarClass) : '';
  if (classNorm) {
    const byClass = CARS.find((c) => normalizeToken(c.carClass) === classNorm);
    if (byClass) return { car: byClass, confidence: 'class_rpm' };
  }

  if (typeof rawMaxRpm === 'number' && Number.isFinite(rawMaxRpm) && rawMaxRpm > 4000) {
    let bestCar: CarProfile | null = null;
    let bestDiff = Infinity;
    for (const car of CARS) {
      const diff = Math.abs(car.maxRpm - rawMaxRpm);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestCar = car;
      }
    }
    if (bestCar && bestDiff <= 250) {
      return { car: bestCar, confidence: 'class_rpm' };
    }
  }

  return { car: null, confidence: 'none' };
}

export function detectSessionFromTelemetry(
  meta: TelemetrySessionMetadata | Partial<TelemetryFrame>
): AutoDetectedSession {
  const simId = matchSimGame(meta.simId ?? ('simName' in meta ? meta.simName : null));
  const trackMatch = matchTrackProfile(
    meta.trackName,
    'trackId' in meta ? meta.trackId : null,
    meta.trackLengthKm
  );
  const carMatch = matchCarProfile(
    meta.carName,
    'carId' in meta ? meta.carId : null,
    meta.carClass,
    meta.maxRpm
  );

  return {
    simId,
    track: trackMatch.track,
    car: carMatch.car,
    rawSimName: (meta.simId ?? ('simName' in meta ? meta.simName : null)) || null,
    rawTrackName: meta.trackName || null,
    rawCarName: meta.carName || null,
    trackConfidence: trackMatch.confidence,
    carConfidence: carMatch.confidence,
  };
}
