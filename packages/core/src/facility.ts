// =============================================================================
// Default facility interiors of the prefabs (a twin inside the twin)
//
// A prefab placed with an interior starts with a plausible layout: levels,
// spaces and equipment in the placement frame (metres; x east, y north at
// heading 0, centred on the placement point). It is a stand-in until the
// facility's own plan arrives; every part is an ontology object that can be
// renamed, moved or bound to a device. Ids are stable for the same parameters.
// =============================================================================

import {
  prefabParams,
  type CityPrefabId,
  type FacilityEquipment,
  type FacilityInterior,
  type FacilityLevel,
  type FacilitySpace,
} from './city-models';

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const r1 = (v: number) => Math.round(v * 10) / 10;

const eq = (
  id: string,
  name: string,
  classId: string,
  x: number,
  y: number,
  size: [number, number, number],
  heading = 0,
): FacilityEquipment => ({ id, name, classId, position: [r1(x), r1(y), 0], size, heading });

/** Evenly spaced positions across [a, b] (n ≥ 1). */
const spread = (a: number, b: number, n: number): number[] =>
  n <= 1 ? [(a + b) / 2] : Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 0.5)) / n);

function solarFarm(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d } = p;
  // Blocks of about 60 m × 60 m (larger on big farms: at most ~300 blocks), each
  // with one inverter station on its south edge.
  const size = Math.max(60, Math.sqrt((w * d) / 300));
  const bx = Math.max(1, Math.round(w / size));
  const by = Math.max(1, Math.round(d / size));
  const spaces: FacilitySpace[] = [];
  let n = 0;
  for (let i = 0; i < bx; i++) {
    for (let j = 0; j < by; j++) {
      n += 1;
      const x0 = -w / 2 + (w * i) / bx;
      const x1 = -w / 2 + (w * (i + 1)) / bx;
      const y0 = -d / 2 + (d * j) / by;
      const y1 = -d / 2 + (d * (j + 1)) / by;
      spaces.push({
        id: `block-${n}`,
        name: `Blok ${n}`,
        classId: 'energy.solar_array',
        polygon: rect(r1(x0 + 2), r1(y0 + 2), r1(x1 - 2), r1(y1 - 2)),
        equipment: [
          eq(`inv-${n}`, `İnvertör ${n}`, 'energy.inverter', (x0 + x1) / 2, y0 + 3, [3, 1.5, 2.4]),
        ],
      });
    }
  }
  spaces.push({
    id: 'yard',
    name: 'Trafo ve kontrol sahası',
    polygon: rect(r1(w / 2 + 4), r1(-d / 2), r1(w / 2 + 34), r1(-d / 2 + 24)),
    equipment: [
      eq(
        'tr-1',
        'Yükseltici trafo',
        'energy.power_transformer',
        w / 2 + 14,
        -d / 2 + 10,
        [6, 4, 5],
      ),
      eq('sw-1', 'Şalt hücresi', 'energy.switchgear', w / 2 + 27, -d / 2 + 10, [8, 3, 3]),
    ],
  });
  return [{ id: 'L0', name: 'Saha', elevation: 0, height: 4, spaces }];
}

function substation(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d } = p;
  const bays = Math.max(2, Math.min(8, Math.round(w / 15)));
  const equipment = spread(-w / 2 + 6, w / 2 - 6, bays).map((x, i) =>
    eq(`tr-${i + 1}`, `Güç trafosu ${i + 1}`, 'energy.power_transformer', x, d / 6, [6, 5, 6]),
  );
  return [
    {
      id: 'L0',
      name: 'Şalt sahası',
      elevation: 0,
      height: 8,
      spaces: [
        {
          id: 'yard',
          name: 'Trafo sahası',
          polygon: rect(-w / 2 + 2, -d / 6, w / 2 - 2, d / 2 - 2),
          equipment,
        },
        {
          id: 'control',
          name: 'Kumanda binası',
          classId: 'building.room',
          polygon: rect(-w / 2 + 2, -d / 2 + 2, -w / 2 + 2 + Math.min(20, w * 0.4), -d / 6 - 1),
          equipment: spread(-w / 2 + 3, -w / 2 + 1 + Math.min(20, w * 0.4), 4).map((x, i) =>
            eq(
              `sw-${i + 1}`,
              `Şalt hücresi ${i + 1}`,
              'energy.switchgear',
              x,
              -d / 2 + 6,
              [2.5, 1.2, 2.2],
            ),
          ),
        },
      ],
    },
  ];
}

function factory(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, height: h, levels } = p;
  const lines = Math.max(1, Math.min(8, Math.floor(d / 14)));
  const machines = Math.max(2, Math.min(16, Math.floor(w / 10)));
  const hall: FacilitySpace = {
    id: 'hall',
    name: 'Üretim holü',
    classId: 'industry.production_hall',
    polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1 - Math.min(20, w / 5), d / 2 - 1),
    equipment: spread(-d / 2 + 4, d / 2 - 4, lines).flatMap((y, li) =>
      spread(-w / 2 + 6, w / 2 - 6 - Math.min(20, w / 5), machines).map((x, mi) =>
        eq(
          `m-${li + 1}-${mi + 1}`,
          `Hat ${li + 1} · Makine ${mi + 1}`,
          'industry.machine',
          x,
          y,
          [4, 3, 2.6],
        ),
      ),
    ),
  };
  const store: FacilitySpace = {
    id: 'store',
    name: 'Hammadde / mamul deposu',
    classId: 'building.hall',
    polygon: rect(w / 2 - Math.min(20, w / 5), -d / 2 + 1, w / 2 - 1, d / 2 - 1),
    equipment: [
      eq('dock-1', 'Yükleme rampası 1', 'industry.loading_dock', w / 2 - 2, -d / 4, [3, 4, 1.2]),
      eq('dock-2', 'Yükleme rampası 2', 'industry.loading_dock', w / 2 - 2, d / 4, [3, 4, 1.2]),
    ],
  };
  const out: FacilityLevel[] = [
    {
      id: 'L0',
      name: 'Zemin kat — üretim',
      elevation: 0,
      height: levels > 1 ? Math.max(5, h * 0.6) : h,
      spaces: [hall, store],
    },
  ];
  for (let i = 1; i < levels; i++) {
    const elevation = r1(
      Math.max(5, h * 0.6) + ((h - Math.max(5, h * 0.6)) * (i - 1)) / Math.max(1, levels - 1),
    );
    out.push({
      id: `L${i}`,
      name: `${i}. kat — idari`,
      elevation,
      height: r1(Math.max(3, (h - Math.max(5, h * 0.6)) / Math.max(1, levels - 1))),
      spaces: [
        {
          id: `off-${i}`,
          name: 'Ofisler',
          classId: 'building.room',
          polygon: rect(-w / 2 + 1, -d / 2 + 1, -w / 6, d / 2 - 1),
        },
        {
          id: `ctl-${i}`,
          name: 'Üretim kontrol odası',
          classId: 'building.room',
          polygon: rect(-w / 6, -d / 2 + 1, w / 8, 0),
        },
      ],
    });
  }
  return out;
}

function warehouse(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, height: h } = p;
  const rows = Math.max(1, Math.floor((w - 10) / 6));
  return [
    {
      id: 'L0',
      name: 'Depo',
      elevation: 0,
      height: h,
      spaces: [
        {
          id: 'racks',
          name: 'Raf alanı',
          classId: 'building.hall',
          polygon: rect(-w / 2 + 1, -d / 2 + 8, w / 2 - 1, d / 2 - 1),
          equipment: spread(-w / 2 + 5, w / 2 - 5, rows).map((x, i) =>
            eq(`rack-${i + 1}`, `Raf ${i + 1}`, 'industry.storage_rack', x, 4, [
              1.2,
              Math.max(2, d - 18),
              Math.min(h - 2, 9),
            ]),
          ),
        },
        {
          id: 'docks',
          name: 'Sevkiyat',
          classId: 'building.hall',
          polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, -d / 2 + 8),
          equipment: spread(-w / 2 + 6, w / 2 - 6, Math.max(2, Math.floor(w / 12))).map((x, i) =>
            eq(
              `dock-${i + 1}`,
              `Rampa ${i + 1}`,
              'industry.loading_dock',
              x,
              -d / 2 + 1.5,
              [3.5, 2, 1.2],
            ),
          ),
        },
      ],
    },
  ];
}

function terminal(p: Record<string, number>): FacilityLevel[] {
  const { length: l, depth: d, levels, gates } = p;
  const fh = 6;
  const plan: FacilityLevel[] = [];
  const names = [
    'Geliş katı',
    'Gidiş katı',
    'Kapılar ve bekleme',
    'Yolcu salonları',
    'Teknik kat',
    'Teras',
  ];
  for (let i = 0; i < levels; i++) {
    const spaces: FacilitySpace[] = [];
    if (i === 0) {
      spaces.push(
        {
          id: 'baggage',
          name: 'Bagaj teslim salonu',
          classId: 'building.hall',
          polygon: rect(-l / 2 + 2, -d / 2 + 2, l / 6, d / 2 - 2),
          equipment: spread(-l / 2 + 15, l / 6 - 10, Math.max(2, Math.round(l / 60))).map((x, k) =>
            eq(`belt-${k + 1}`, `Bagaj bandı ${k + 1}`, 'aviation.baggage_claim', x, 0, [6, 24, 1]),
          ),
        },
        {
          id: 'arrivals',
          name: 'Karşılama holü',
          classId: 'building.hall',
          polygon: rect(l / 6, -d / 2 + 2, l / 2 - 2, d / 2 - 2),
        },
      );
    } else if (i === 1) {
      const counters = Math.max(4, Math.min(60, Math.round(l / 10)));
      spaces.push(
        {
          id: 'checkin',
          name: 'Check-in salonu',
          classId: 'building.hall',
          polygon: rect(-l / 2 + 2, -d / 2 + 2, l / 4, 0),
          equipment: spread(-l / 2 + 6, l / 4 - 4, counters).map((x, k) =>
            eq(
              `ci-${k + 1}`,
              `Banko ${k + 1}`,
              'aviation.checkin_counter',
              x,
              -d / 4,
              [2.5, 1.2, 1.1],
            ),
          ),
        },
        {
          id: 'security',
          name: 'Güvenlik kontrolü',
          classId: 'building.hall',
          polygon: rect(l / 4, -d / 2 + 2, l / 2 - 2, 0),
          equipment: spread(l / 4 + 4, l / 2 - 6, 4).map((x, k) =>
            eq(
              `sec-${k + 1}`,
              `Güvenlik hattı ${k + 1}`,
              'aviation.security_checkpoint',
              x,
              -d / 4,
              [3, 6, 2],
            ),
          ),
        },
      );
    } else {
      spaces.push({
        id: `L${i}-hall`,
        name: names[i] ?? `${i}. kat`,
        classId: 'building.hall',
        polygon: rect(-l / 2 + 2, -d / 2 + 2, l / 2 - 2, d / 2 - 2),
      });
    }
    plan.push({
      id: `L${i}`,
      name: names[i] ?? `${i}. kat`,
      elevation: i * fh,
      height: fh,
      spaces,
    });
  }
  // Gates line the airside (north) face of the departures level.
  const gateLevel = plan[Math.min(levels - 1, 1)];
  gateLevel.spaces.push({
    id: 'gates',
    name: 'Kapılar',
    classId: 'building.hall',
    polygon: rect(-l / 2 + 2, 0, l / 2 - 2, d / 2 - 2),
    equipment: spread(-l / 2 + 15, l / 2 - 15, gates).map((x, k) =>
      eq(
        `gate-${k + 1}`,
        `Kapı ${k + 1} köprüsü`,
        'aviation.jet_bridge',
        x,
        d / 2 + 12,
        [4, 24, 4],
      ),
    ),
  });
  return plan;
}

function stadium(p: Record<string, number>): FacilityLevel[] {
  const { length: l, width: w } = p;
  const pitch: FacilitySpace = {
    id: 'pitch',
    name: 'Saha',
    classId: 'social.pitch',
    polygon: rect(-52.5, -34, 52.5, 34),
  };
  const sectors: FacilitySpace[] = [
    {
      id: 'north',
      name: 'Kuzey tribünü',
      classId: 'social.stand_sector',
      polygon: rect(-l / 2 + 8, 40, l / 2 - 8, w / 2 - 4),
    },
    {
      id: 'south',
      name: 'Güney tribünü',
      classId: 'social.stand_sector',
      polygon: rect(-l / 2 + 8, -w / 2 + 4, l / 2 - 8, -40),
    },
    {
      id: 'east',
      name: 'Doğu kale arkası',
      classId: 'social.stand_sector',
      polygon: rect(60, -38, l / 2 - 4, 38),
    },
    {
      id: 'west',
      name: 'Batı kale arkası',
      classId: 'social.stand_sector',
      polygon: rect(-l / 2 + 4, -38, -60, 38),
    },
  ];
  sectors[1].equipment = spread(-l / 3, l / 3, 6).map((x, k) =>
    eq(`ts-${k + 1}`, `Turnike ${k + 1}`, 'social.turnstile', x, -w / 2 + 2, [2, 1, 1.2]),
  );
  return [
    { id: 'L0', name: 'Saha ve tribünler', elevation: 0, height: 8, spaces: [pitch, ...sectors] },
  ];
}

function civic(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels } = p;
  const fh = 3.6;
  return Array.from({ length: levels }, (_, i) => {
    const spaces: FacilitySpace[] =
      i === 0
        ? [
            {
              id: 'service',
              name: 'Vatandaş hizmet holü',
              classId: 'building.hall',
              polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, 0),
              equipment: spread(-w / 2 + 4, w / 2 - 4, Math.max(2, Math.round(w / 8))).map((x, k) =>
                eq(
                  `desk-${k + 1}`,
                  `Hizmet masası ${k + 1}`,
                  'building.service_desk',
                  x,
                  -d / 4,
                  [2, 1, 1.1],
                ),
              ),
            },
            {
              id: 'L0-off',
              name: 'Ofisler',
              classId: 'building.room',
              polygon: rect(-w / 2 + 1, 0, w / 2 - 1, d / 2 - 1),
            },
          ]
        : i === levels - 1 && levels > 1
          ? [
              {
                id: 'council',
                name: 'Meclis salonu',
                classId: 'building.common_area',
                polygon: rect(-w / 3, -d / 2 + 1, w / 3, d / 2 - 1),
              },
            ]
          : [
              {
                id: `L${i}-a`,
                name: 'Birim ofisleri (batı)',
                classId: 'building.room',
                polygon: rect(-w / 2 + 1, -d / 2 + 1, -1, d / 2 - 1),
              },
              {
                id: `L${i}-b`,
                name: 'Birim ofisleri (doğu)',
                classId: 'building.room',
                polygon: rect(1, -d / 2 + 1, w / 2 - 1, d / 2 - 1),
              },
            ];
    return {
      id: `L${i}`,
      name: i === 0 ? 'Zemin kat' : `${i}. kat`,
      elevation: r1(i * fh),
      height: fh,
      spaces,
    };
  });
}

/** Floors of a multi-storey building: `spacesOf(i)` lays out floor i. */
function floors(
  levels: number,
  fh: number,
  spacesOf: (i: number) => FacilitySpace[],
  nameOf: (i: number) => string = (i) => (i === 0 ? 'Zemin kat' : `${i}. kat`),
): FacilityLevel[] {
  return Array.from({ length: levels }, (_, i) => ({
    id: `L${i}`,
    name: nameOf(i),
    elevation: r1(i * fh),
    height: fh,
    spaces: spacesOf(i),
  }));
}

/** Splits [x0, x1] into n strips of rooms along y [y0, y1]. */
const strip = (
  prefix: string,
  name: (k: number) => string,
  classId: string,
  n: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): FacilitySpace[] =>
  Array.from({ length: n }, (_, k) => ({
    id: `${prefix}-${k + 1}`,
    name: name(k),
    classId,
    polygon: rect(r1(x0 + ((x1 - x0) * k) / n), y0, r1(x0 + ((x1 - x0) * (k + 1)) / n), y1),
  }));

function hospital(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels } = p;
  return floors(levels, 4, (i) => {
    if (i === 0)
      return [
        {
          id: 'er',
          name: 'Acil servis',
          classId: 'health.emergency_department',
          polygon: rect(-w / 2 + 1, -d / 2 + 1, -w / 6, d / 2 - 1),
        },
        {
          id: 'lobby',
          name: 'Giriş ve danışma',
          classId: 'building.hall',
          polygon: rect(-w / 6, -d / 2 + 1, w / 6, d / 2 - 1),
        },
        {
          id: 'imaging',
          name: 'Görüntüleme (MR, BT, röntgen)',
          classId: 'building.room',
          polygon: rect(w / 6, -d / 2 + 1, w / 2 - 1, d / 2 - 1),
        },
      ];
    if (i === 1)
      return strip(
        'pol',
        (k) => `Poliklinik ${k + 1}`,
        'building.room',
        Math.max(2, Math.round(w / 12)),
        -w / 2 + 1,
        w / 2 - 1,
        -d / 2 + 1,
        d / 2 - 1,
      );
    if (i === 2 && levels > 3)
      return [
        {
          id: 'or',
          name: 'Ameliyathaneler',
          classId: 'building.room',
          polygon: rect(-w / 2 + 1, -d / 2 + 1, 0, d / 2 - 1),
        },
        {
          id: 'icu',
          name: 'Yoğun bakım',
          classId: 'building.room',
          polygon: rect(0, -d / 2 + 1, w / 2 - 1, d / 2 - 1),
        },
      ];
    return strip(
      `w${i}`,
      (k) => `${i}. kat servis odası ${k + 1}`,
      'building.room',
      Math.max(4, Math.round(w / 6)),
      -w / 2 + 1,
      w / 2 - 1,
      0,
      d / 2 - 1,
    ).concat({
      id: `w${i}-hall`,
      name: 'Koridor ve hemşire istasyonu',
      classId: 'building.hall',
      polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, 0),
    });
  });
}

function school(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels } = p;
  const rooms = Math.max(2, Math.round(w / 8));
  return floors(levels, 3.6, (i) =>
    i === 0
      ? [
          {
            id: 'hall',
            name: 'Giriş ve kantin',
            classId: 'building.hall',
            polygon: rect(-w / 2 + 1, -d / 2 + 1, -w / 6, d / 2 - 1),
          },
          ...strip(
            'c0',
            (k) => `Derslik ${k + 1}`,
            'building.room',
            Math.max(1, rooms - 2),
            -w / 6,
            w / 2 - 1,
            0,
            d / 2 - 1,
          ),
          {
            id: 'c0-corr',
            name: 'Koridor',
            classId: 'building.hall',
            polygon: rect(-w / 6, -d / 2 + 1, w / 2 - 1, 0),
          },
        ]
      : [
          ...strip(
            `c${i}`,
            (k) => `Derslik ${i}${String(k + 1).padStart(2, '0')}`,
            'building.room',
            rooms,
            -w / 2 + 1,
            w / 2 - 1,
            0,
            d / 2 - 1,
          ),
          {
            id: `c${i}-corr`,
            name: 'Koridor',
            classId: 'building.hall',
            polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, 0),
          },
        ],
  );
}

/** Flats per floor along the long side, a stair core in the middle (daire seviyesi). */
function apartmentBlock(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels, unitsPerFloor: n } = p;
  const core = Math.min(4, w / 6);
  const half = Math.ceil(n / 2);
  return floors(levels, 3, (i) => {
    const units: FacilitySpace[] = [];
    let no = i * n;
    for (const [y0, y1, count] of [
      [-d / 2 + 1, -core / 2, half],
      [core / 2, d / 2 - 1, n - half],
    ] as const) {
      for (let k = 0; k < count; k++) {
        no += 1;
        units.push({
          id: `u-${no}`,
          name: `Daire ${no}`,
          classId: 'building.unit',
          polygon: rect(
            r1(-w / 2 + 1 + ((w - 2) * k) / count),
            r1(y0),
            r1(-w / 2 + 1 + ((w - 2) * (k + 1)) / count),
            r1(y1),
          ),
          equipment: [
            eq(
              `u-${no}-em`,
              `Daire ${no} elektrik sayacı`,
              'resident.meter_electricity',
              -w / 2 + 2 + ((w - 2) * k) / count,
              (y0 + y1) / 2,
              [0.4, 0.2, 0.6],
            ),
          ],
        });
      }
    }
    units.push({
      id: `core-${i}`,
      name: 'Merdiven ve asansör',
      classId: 'building.stairwell',
      polygon: rect(-core, -core / 2, core, core / 2),
    });
    return units;
  });
}

function officeTower(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels } = p;
  const c = Math.min(w, d) / 4;
  return floors(levels, 3.8, (i) => [
    {
      id: `core-${i}`,
      name: 'Çekirdek (asansör, merdiven)',
      classId: 'building.stairwell',
      polygon: rect(-c, -c, c, c),
    },
    ...(i === 0
      ? [
          {
            id: 'lobby',
            name: 'Lobi',
            classId: 'building.hall',
            polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, -c - 1),
          },
        ]
      : [
          {
            id: `o${i}-s`,
            name: 'Ofis katı (güney)',
            classId: 'building.room',
            polygon: rect(-w / 2 + 1, -d / 2 + 1, w / 2 - 1, -c - 1),
          },
          {
            id: `o${i}-n`,
            name: 'Ofis katı (kuzey)',
            classId: 'building.room',
            polygon: rect(-w / 2 + 1, c + 1, w / 2 - 1, d / 2 - 1),
          },
        ]),
  ]);
}

function shoppingMall(p: Record<string, number>): FacilityLevel[] {
  const { width: w, depth: d, levels } = p;
  const shops = Math.max(4, Math.round(w / 14));
  return floors(
    levels,
    5.5,
    (i) => [
      ...strip(
        `s${i}n`,
        (k) => `Mağaza ${i}N${k + 1}`,
        'commerce.shop' as string,
        shops,
        -w / 2 + 1,
        w / 2 - 1,
        d / 6,
        d / 2 - 1,
      ),
      ...strip(
        `s${i}s`,
        (k) => `Mağaza ${i}S${k + 1}`,
        'commerce.shop' as string,
        shops,
        -w / 2 + 1,
        w / 2 - 1,
        -d / 2 + 1,
        -d / 6,
      ),
      {
        id: `mall-${i}`,
        name: i === levels - 1 && levels > 1 ? 'Yemek katı' : 'Pasaj',
        classId: 'building.hall',
        polygon: rect(-w / 2 + 1, -d / 6, w / 2 - 1, d / 6),
      },
    ],
    (i) => (i === 0 ? 'Zemin kat' : `${i}. kat`),
  );
}

/** Underground: concourse a few metres down, platforms at the given depth. */
function metroStation(p: Record<string, number>): FacilityLevel[] {
  const { length: l, depth } = p;
  return [
    {
      id: 'B1',
      name: 'Bilet holü (-1)',
      elevation: -6,
      height: 5,
      spaces: [
        {
          id: 'concourse',
          name: 'Bilet holü',
          classId: 'building.hall',
          polygon: rect(-30, -10, 30, 10),
          equipment: spread(-12, 12, 6).map((x, k) =>
            eq(`fg-${k + 1}`, `Turnike ${k + 1}`, 'transit.fare_gate', x, 0, [1, 0.3, 1.1]),
          ),
        },
      ],
    },
    {
      id: 'B2',
      name: 'Peron katı',
      elevation: -depth,
      height: 6,
      spaces: [
        {
          id: 'platform',
          name: 'Ada peron',
          classId: 'transit.metro_platform',
          polygon: rect(-l / 2, -6, l / 2, 6),
        },
        { id: 'track-n', name: 'Hat 1 (kuzey)', polygon: rect(-l / 2 - 20, 6, l / 2 + 20, 11) },
        { id: 'track-s', name: 'Hat 2 (güney)', polygon: rect(-l / 2 - 20, -11, l / 2 + 20, -6) },
      ],
    },
  ];
}

/** Depth (m) of one row of bus bays with its driving lane, north of the terminal building. */
const BAY_ROW = 34;
/** Least bay pitch (m) along a row: angled (sawtooth) bays of a 12 m coach. */
const BAY_PITCH = 4.6;

/**
 * Bus bays of an intercity terminal (otogar): rows of angled sawtooth bays
 * north of the building, each row under its own canopy. Shared by the
 * facility plan and the 3D prefab so the bay points sit on the drawn bays.
 * Model frame: x east, y north, metres from the placement point.
 */
export function busTerminalBays(p: Record<string, number>): {
  rows: number;
  /** Centre line (y) of each row's bays. */
  rowY: number[];
  bays: { x: number; y: number; row: number }[];
} {
  const { length: l, depth: d, bays } = p;
  const perRow = Math.max(1, Math.floor((l - 12) / BAY_PITCH));
  const rows = Math.ceil(bays / perRow);
  const rowY = Array.from({ length: rows }, (_, r) => d / 2 + 14 + r * BAY_ROW);
  const out: { x: number; y: number; row: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const n = Math.min(perRow, bays - r * perRow);
    for (const x of spread(-l / 2 + 6, l / 2 - 6, n)) out.push({ x, y: rowY[r], row: r });
  }
  return { rows, rowY, bays: out };
}

function busTerminal(p: Record<string, number>): FacilityLevel[] {
  const { length: l, depth: d, levels } = p;
  const { rows, rowY, bays } = busTerminalBays(p);
  const offices = Math.max(4, Math.min(48, Math.round(l / 7)));
  const plan: FacilityLevel[] = [
    {
      id: 'L0',
      name: 'Zemin kat — yazıhaneler ve peronlar',
      elevation: 0,
      height: 5,
      spaces: [
        {
          id: 'offices',
          name: 'Yazıhaneler (bilet gişeleri)',
          classId: 'building.hall',
          polygon: rect(-l / 2 + 2, -d / 2 + 2, l / 2 - 2, 0),
          equipment: spread(-l / 2 + 4, l / 2 - 4, offices).map((x, k) =>
            eq(`office-${k + 1}`, `Yazıhane ${k + 1}`, 'transit.ticket_office', x, -d / 4, [
              Math.min(5, (l - 8) / offices - 0.5),
              3,
              2.6,
            ]),
          ),
        },
        {
          id: 'waiting',
          name: 'Bekleme salonu',
          classId: 'building.hall',
          polygon: rect(-l / 2 + 2, 0, l / 2 - 2, d / 2 - 2),
        },
        {
          id: 'platforms',
          name: `Peronlar (${bays.length})`,
          polygon: rect(-l / 2, d / 2, l / 2, rowY[rows - 1] + BAY_ROW / 2),
          equipment: bays.map((b, k) =>
            eq(`bay-${k + 1}`, `Peron ${k + 1}`, 'transit.bus_bay', b.x, b.y, [3.5, 13, 0.3], 30),
          ),
        },
      ],
    },
  ];
  const upper = [
    ['Yeme içme ve dükkânlar', 'Yemek katı', 'Dükkânlar'],
    ['Firma ofisleri', 'Ofisler (batı)', 'Ofisler (doğu)'],
    ['Teknik kat', 'Teknik hacimler', 'İşletme'],
  ];
  for (let i = 1; i < levels; i++) {
    const [name, west, east] = upper[Math.min(i - 1, upper.length - 1)];
    plan.push({
      id: `L${i}`,
      name: `${i}. kat — ${name}`,
      elevation: i * 5,
      height: 4.5,
      spaces: [
        {
          id: 'west',
          name: west,
          classId: 'building.common_area',
          polygon: rect(-l / 2 + 2, -d / 2 + 2, -1, d / 2 - 2),
        },
        {
          id: 'east',
          name: east,
          classId: 'building.common_area',
          polygon: rect(1, -d / 2 + 2, l / 2 - 2, d / 2 - 2),
        },
      ],
    });
  }
  return plan;
}

function tentCamp(p: Record<string, number>): FacilityLevel[] {
  const { rows, cols } = p;
  const w = cols * 8;
  const d = rows * 8;
  return [
    {
      id: 'L0',
      name: 'Çadır alanı',
      elevation: 0,
      height: 3,
      spaces: [
        {
          id: 'tents',
          name: `Çadırlar (${rows * cols})`,
          classId: 'safety.temporary_shelter',
          polygon: rect(-w / 2, -d / 2, w / 2, d / 2),
        },
        {
          id: 'service',
          name: 'Mutfak, sağlık, WC',
          classId: 'building.common_area',
          polygon: rect(w / 2 + 4, -d / 2, w / 2 + 24, d / 2),
        },
      ],
    },
  ];
}

const BUILDERS: Partial<Record<CityPrefabId, (p: Record<string, number>) => FacilityLevel[]>> = {
  solar_farm: solarFarm,
  substation,
  factory,
  warehouse,
  airport_terminal: terminal,
  stadium,
  civic_building: civic,
  hospital,
  school,
  apartment_block: apartmentBlock,
  office_tower: officeTower,
  shopping_mall: shoppingMall,
  metro_station: metroStation,
  bus_terminal: busTerminal,
  tent_camp: tentCamp,
};

/** The interior a prefab starts with (null: the prefab has none). */
export function defaultInterior(
  prefab: CityPrefabId,
  given: Record<string, number> = {},
): FacilityInterior | null {
  const build = BUILDERS[prefab];
  return build ? { levels: build(prefabParams(prefab, given)) } : null;
}
