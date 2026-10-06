'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { DtView } from './DtHud';

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
  const shown = planned > 0 ? Math.min(planned, Math.max(0, planned - loading)) : loaded;
  const share = planned > 0 ? shown / planned : 0;

  if (loaded === 0) {
    const stage = !tiles
      ? t('locating')
      : planned === 0 && server > 0
        ? t('server', { count: server })
        : t('tiles', { loaded: shown, planned: Math.max(planned, 1) });
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="glass-float w-[320px] rounded-xl px-5 py-4 shadow-2xl">
          <div className="flex items-center gap-2.5 text-sm font-medium text-foreground/85">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            {t('title')}
          </div>
          <div className="mt-1.5 text-xs text-foreground/60">{stage}</div>
          {planned === 0 && server > 0 && (
            <div className="mt-1 text-[11px] text-foreground/45">{t('serverHint')}</div>
          )}
          <Bar share={!tiles || planned === 0 ? null : share} />
        </div>
      </div>
    );
  }

  if (!busy) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2">
      <div className="glass-float flex w-[260px] flex-col gap-1.5 rounded-lg px-3 py-2 shadow-xl">
        <div className="flex items-center justify-between gap-2 text-[11px] text-foreground/70">
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            {loading > 0 ? t('pill', { loaded: shown, planned }) : t('pillServerOnly')}
          </span>
          {server > 0 && (
            <span className="text-foreground/45">{t('pillServer', { count: server })}</span>
          )}
        </div>
        <Bar share={loading > 0 && planned > 0 ? share : null} thin />
      </div>
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
