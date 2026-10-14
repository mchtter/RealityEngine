'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { DtView } from './DtHud';
import { KentOSLoader, KentOSMark } from '@/components/brand/KentOSLoader';

/** Remembered per viewer: whether the loading pill shows its detail rows. */
const DETAILS_KEY = 'dt.loadDetails';

interface DtLoadingProps {
  /** Tile progress; null before the first tile list arrived. */
  tiles: DtView['tiles'] | null;
  error: string | null;
}

/**
 * What the city is doing while it loads. Before the first tile a card in the
 * middle (what stage, how far); afterwards a small bar at the top while
 * tiles stream in (moving the camera, flying to a scenario), gone when done.
 */
export function DtLoading({ tiles, error }: DtLoadingProps) {
  const t = useTranslations('dt.load');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(DETAILS_KEY) === '1');
    } catch {
      // Storage blocked: closed.
    }
  }, []);
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(DETAILS_KEY, o ? '0' : '1');
      } catch {
        // Storage blocked: not remembered.
      }
      return !o;
    });
  if (error) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="glass-float rounded-xl px-5 py-3.5 text-sm text-danger shadow-2xl">
          {error}
        </div>
      </div>
    );
  }
  const loaded = tiles?.loaded ?? 0;
  const planned = tiles?.planned ?? 0;
  const loading = tiles?.loading ?? 0;
  const server = tiles?.pending ?? 0;
  // Tiles still to come into view: being built here, or compiled on the server.
  const busy = loading > 0 || server > 0;
  const shown = planned > 0 ? Math.min(planned, tiles?.shown ?? 0) : loaded;
  const share = planned > 0 ? shown / planned : 0;

  if (loaded === 0) {
    const stage = !tiles
      ? t('locating')
      : planned === 0 && server > 0
        ? t('server', { count: server })
        : t('tiles', { loaded: shown, planned: Math.max(planned, 1) });
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <KentOSLoader
          variant="card"
          tagline={t('tagline')}
          label={planned === 0 && server > 0 ? `${stage} — ${t('serverHint')}` : stage}
          progress={!tiles || planned === 0 ? null : share}
        />
      </div>
    );
  }

  // After the first tiles: only while something in front of the camera is
  // missing (grey) or compiling; loading further out and detail upgrades run quietly.
  const near = tiles?.near;
  if (!busy || !near || (near.missing === 0 && near.compiling === 0)) return null;
  const work = tiles?.work;
  const device = (work?.full ?? 0) + (work?.far ?? 0);
  const failed = tiles?.failed ?? 0;
  return (
    <div className="absolute left-1/2 top-16 z-20 -translate-x-1/2">
      <div className="glass-float flex w-[300px] flex-col gap-1.5 rounded-lg px-3 py-2 shadow-xl">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? t('hideDetails') : t('showDetails')}
          className="flex items-center justify-between gap-2 text-left text-[11px] text-foreground/75"
        >
          <span className="flex items-center gap-1.5">
            <KentOSMark className="h-4 w-4 shrink-0" />
            <span className="font-medium">{t('kentos')}</span>
            <span className="text-foreground/50">
              {loading > 0 ? t('count', { loaded: shown, planned }) : t('pillServerOnly')}
            </span>
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-foreground/45 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <Bar share={loading > 0 && planned > 0 ? share : null} thin />
        {open && (
          <dl className="mt-1 flex flex-col gap-1.5 border-t border-foreground/10 pt-2 text-[11px]">
            <Row label={t('rowView')} value={t('rowViewValue', { loaded: shown, planned })} />
            {device > 0 && (
              <Row
                label={t('rowDevice')}
                value={t('rowDeviceValue', { count: device })}
                note={[
                  t('rowDeviceParts', { full: work?.full ?? 0, far: work?.far ?? 0 }),
                  ...((work?.refresh ?? 0) > 0 ? [t('rowRefresh', { count: work!.refresh })] : []),
                ].join(' · ')}
              />
            )}
            {(work?.utilities ?? 0) > 0 && (
              <Row
                label={t('rowUtilities')}
                value={t('rowDeviceValue', { count: work!.utilities })}
              />
            )}
            {server > 0 && (
              <Row
                label={t('rowServer')}
                value={t('rowDeviceValue', { count: server })}
                note={t('rowServerHint')}
              />
            )}
            {failed > 0 && (
              <Row label={t('rowFailed')} value={t('rowDeviceValue', { count: failed })} danger />
            )}
            <p className="text-[10.5px] leading-snug text-foreground/45">{t('moveHint')}</p>
          </dl>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  danger = false,
}: {
  label: string;
  value: string;
  note?: string;
  danger?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-foreground/60">{label}</dt>
        <dd className={`tabular-nums ${danger ? 'text-danger' : 'text-foreground/85'}`}>{value}</dd>
      </div>
      {note && <div className="mt-0.5 text-[10.5px] leading-snug text-foreground/45">{note}</div>}
    </div>
  );
}

/** Progress bar; `share` null = indeterminate. */
function Bar({ share, thin = false }: { share: number | null; thin?: boolean }) {
  return (
    <div
      className={`relative mt-2 w-full overflow-hidden rounded-full bg-foreground/10 ${thin ? 'mt-0 h-1' : 'h-1.5'}`}
    >
      {share === null ? (
        <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-primary/60" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.max(4, Math.round(share * 100))}%` }}
        />
      )}
    </div>
  );
}
