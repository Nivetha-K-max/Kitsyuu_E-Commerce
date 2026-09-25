/* Catalogue shapes the storefront renders. Since Phase 4.3 they are filled from Supabase (lib/catalogue.ts);
   the shape still mirrors data/products.json, which remains the seed/reference file. */
export type Variant = { size: string; available: boolean };

export type MediaImage = {
  src: string;
  width: number;
  height: number;
  alt: string;
  quality?: string;
  zoom?: boolean;
};

export type Media = {
  status: string;
  primary: MediaImage | null;
  placeholder: string;
  gallery: MediaImage[];
};

export type Product = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  category: string;
  subcategory: string;
  description: string;
  features: string[];
  colour: { label: string; swatches: string[] };
  price: number;
  variants: Variant[];
  featured: boolean;
  styledWith: string[];
  media: Media;
  catalogueRef: string | null;
  material: string | null;
  care: string | null;
  origin: string | null;
};

export type Category = { id: string; label: string; parent: string | null };

export type Collection = { id: string; label: string; dataStatus: string; productIds: string[] };

export type NavEntry = { label: string; collection?: string; category?: string; all?: boolean };

export type Catalogue = {
  meta: { currency: string; priceIncludesTax: boolean | null; images: { placeholder: string } };
  categories: Category[];
  collections: Collection[];
  navigation: NavEntry[];
  products: Product[];
};

/* A cart line as stored in localStorage (kitsyuu-cart-v1); same format as the static store. */
export type CartLine = {
  id: string;
  sku: string;
  name: string;
  image: string | null;
  price: number;
  size: string;
  qty: number;
};
