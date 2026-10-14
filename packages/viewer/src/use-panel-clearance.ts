import { useEffect, useState } from 'react';

/**
 * The platform's floating panel layer (FloatingPanels, `data-floating-root`):
 * the digital twin's panels are portalled there so they sit, size and stack
 * exactly like Katmanlar, Mekansal Analiz and the others.
 */
export function useFloatingHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const find = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>('[data-floating-root]');
      if (el) setHost(el);
      else frame = requestAnimationFrame(find);
    };
    find();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);
  return host;
}
