/* Icons: lucide, one stroke width (1.5) everywhere. Pages use <Icon name="…" /> so the set is chosen in one place.
   Decorative: always aria-hidden; the text next to an icon is its label. */
import {
  Activity, Archive, ArchiveRestore, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Bell, Boxes, ChartColumn, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, CircleAlert, ClipboardList, Columns3, CornerDownLeft, CreditCard, Download, Ellipsis,
  ExternalLink, Factory, ImageOff, Inbox, IndianRupee, Keyboard, Layers, LayoutDashboard, ListFilter, LogOut, Megaphone, Menu, Monitor,
  Moon, Package, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Rows3, ScrollText, Search, Settings, ShieldCheck, ShoppingCart,
  SlidersHorizontal, Star, Sun, SunMoon, Tags, TriangleAlert, Truck, Upload, User, UserCog, Users, Warehouse, X, Cylinder, MapPin, ArrowLeftRight,
  BadgePercent, PackageCheck, Undo2, Sparkles, LifeBuoy, Landmark, ShoppingBasket, BellRing, Ruler, Gift, ClipboardPen,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard, locations: MapPin, transfers: ArrowLeftRight, reports: ChartColumn, products: Package, categories: Tags, collections: Layers, attributes: SlidersHorizontal,
  inventory: Boxes, counts: ClipboardList, value: IndianRupee, orders: ShoppingCart, customers: Users, payments: CreditCard, reviews: Star,
  content: Megaphone, vendors: Truck, materials: Cylinder, purchase: ScrollText, production: Factory, staff: UserCog, roles: ShieldCheck,
  audit: Activity, settings: Settings, system: Warehouse, account: User, logout: LogOut, sun: Sun, moon: Moon, monitor: Monitor, theme: SunMoon,
  menu: Menu, close: X, plus: Plus, arrow: ArrowRight, alert: TriangleAlert, upload: Upload, inbox: Inbox, search: Search, bell: Bell,
  more: Ellipsis, check: Check, 'chevron-down': ChevronDown, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, updown: ChevronsUpDown,
  'sort-asc': ArrowUp, 'sort-desc': ArrowDown, sort: ArrowUpDown, 'no-image': ImageOff, external: ExternalLink, archive: Archive,
  restore: ArchiveRestore, edit: Pencil, download: Download, columns: Columns3, density: Rows3, filter: ListFilter, info: CircleAlert,
  enter: CornerDownLeft, keyboard: Keyboard, 'panel-close': PanelLeftClose, 'panel-open': PanelLeftOpen, star: Star,
  pricing: BadgePercent, shipping: PackageCheck, returns: Undo2, marketing: Sparkles, support: LifeBuoy, finance: Landmark, carts: ShoppingBasket,
  notifications: BellRing, sizecharts: Ruler, loyalty: Gift, drafts: ClipboardPen,
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, fill }: { name: string; size?: number; fill?: boolean }) {
  const C = ICONS[name] ?? LayoutDashboard;
  return <C className="icon" size={size} strokeWidth={1.5} aria-hidden="true" focusable="false" fill={fill ? 'currentColor' : 'none'} />;
}
