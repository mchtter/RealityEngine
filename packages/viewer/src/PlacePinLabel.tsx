'use client';

import type { CitySpecialArea } from '@kavra/core';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type MutableRefObject, useEffect, useRef } from 'react';
import type { DtEngine } from './engine/DtEngine';
import { SPECIAL_AREA_ICONS } from './special-areas';

/**
 * The label on top of a pinned place's mast: a square with the place's icon
 * and its name beside it. It rides the mast's top every frame (moved by
 * style, not re-rendered) and hides while the top is off screen.
 */
export function PlacePinLabel({
  engine,
  phase,
  area,
  onClose,
}: {
  engine: MutableRefObject<DtEngine | null>;
  phase: string;
  area: CitySpecialArea;
  onClose: () => void;
}) {
  const t = useTranslations('dt.specialAreas');
  const ref = useRef<HTMLDivElement>(null);
  const Icon = SPECIAL_AREA_ICONS[area.kind];

  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    return e.onPinScreen((p) => {
      const el = ref.current;
      if (!el) return;
      el.style.visibility = p ? 'visible' : 'hidden';
      if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    });
  }, [engine, phase]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute left-0 top-0 z-10"
      style={{ visibility: 'hidden' }}
    >
      {/* The square's centre sits on the mast's top. */}
      <div className="flex -translate-x-[14px] -translate-y-1/2 items-center gap-1.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-white/90 bg-black/70 shadow-lg">
          <Icon className="h-4 w-4 text-white" />
        </span>
        <span className="pointer-events-auto flex items-center gap-1 whitespace-nowrap rounded-md bg-black/65 px-2 py-1 text-[12px] font-semibold text-white shadow-lg">
          {area.name ?? t('unnamed', { kind: t(`kinds.${area.kind}`) })}
          <button
            type="button"
            onClick={onClose}
            title={t('unpin')}
            className="ml-0.5 rounded text-white/60 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
    </div>
  );
}
