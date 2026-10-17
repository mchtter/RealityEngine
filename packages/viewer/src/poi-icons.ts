import {
  Baby,
  Banknote,
  BedDouble,
  Beer,
  BookOpen,
  Building2,
  Bus,
  Camera,
  Coffee,
  CreditCard,
  Croissant,
  Flame,
  GraduationCap,
  Hospital,
  Landmark,
  type LucideIcon,
  Mail,
  MoonStar,
  Pill,
  Sandwich,
  School,
  Shield,
  ShoppingBag,
  ShoppingCart,
  SquareParking,
  Stethoscope,
  Store,
  Theater,
  TrainFront,
  Utensils,
} from 'lucide-react';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

/** The app's icon for each point-of-interest kind the DT map draws (engine POI_ICON_KINDS). */
const POI_ICON: Record<string, LucideIcon> = {
  restaurant: Utensils,
  fast_food: Sandwich,
  cafe: Coffee,
  bar: Beer,
  bakery: Croissant,
  supermarket: ShoppingCart,
  mall: ShoppingBag,
  shop: Store,
  pharmacy: Pill,
  hospital: Hospital,
  clinic: Stethoscope,
  school: School,
  university: GraduationCap,
  kindergarten: Baby,
  library: BookOpen,
  place_of_worship: MoonStar,
  museum: Landmark,
  culture: Theater,
  hotel: BedDouble,
  attraction: Camera,
  bank: Banknote,
  atm: CreditCard,
  post_office: Mail,
  police: Shield,
  fire_station: Flame,
  public_office: Building2,
  bus_station: Bus,
  parking: SquareParking,
  subway_entrance: TrainFront,
};

/** SVG markup of each kind's icon (white strokes), rendered once off-screen for the engine. */
export function poiIconSvgs(): Record<string, string> {
  const div = document.createElement('div');
  const root = createRoot(div);
  const out: Record<string, string> = {};
  for (const [kind, icon] of Object.entries(POI_ICON)) {
    flushSync(() =>
      root.render(createElement(icon, { size: 24, color: '#ffffff', strokeWidth: 2.4 })),
    );
    out[kind] = div.innerHTML;
  }
  root.unmount();
  return out;
}
