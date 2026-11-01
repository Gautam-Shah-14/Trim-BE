export type Audience = 'all' | 'men' | 'women' | 'kids';

/** [category, name, audience, default duration (min), suggested price (paise)] */
export type TemplateRow = [string, string, Audience, number, number];

export const SERVICE_TEMPLATES: TemplateRow[] = [
  ['Hair', 'Haircut', 'all', 30, 30000],
  ['Hair', 'Kids haircut', 'kids', 20, 20000],
  ['Hair', 'Hair wash & blow-dry', 'all', 30, 25000],
  ['Hair', 'Styling', 'all', 30, 30000],
  ['Hair', 'Hair colour', 'all', 90, 150000],
  ['Hair', 'Highlights', 'all', 120, 250000],
  ['Hair', 'Global colour', 'all', 150, 350000],
  ['Hair', 'Keratin / smoothening', 'all', 180, 450000],
  ['Hair', 'Hair spa', 'all', 60, 120000],
  ['Hair', 'Scalp treatment', 'all', 45, 100000],
  ['Beard & shave', 'Beard trim', 'men', 20, 15000],
  ['Beard & shave', 'Beard styling', 'men', 30, 25000],
  ['Beard & shave', 'Clean shave', 'men', 20, 15000],
  ['Beard & shave', 'Moustache trim', 'men', 10, 8000],
  ['Skin', 'Cleanup', 'all', 40, 60000],
  ['Skin', 'Facial', 'all', 60, 100000],
  ['Skin', 'De-tan', 'all', 30, 70000],
  ['Skin', 'Bleach', 'all', 30, 50000],
  ['Skin', 'Threading', 'all', 15, 8000],
  ['Skin', 'Waxing - arms', 'all', 30, 30000],
  ['Skin', 'Waxing - legs', 'all', 45, 50000],
  ['Skin', 'Waxing - full body', 'all', 90, 180000],
  ['Nails', 'Manicure', 'all', 45, 60000],
  ['Nails', 'Pedicure', 'all', 60, 80000],
  ['Spa', 'Head massage', 'all', 20, 30000],
  ['Spa', 'Body massage', 'all', 60, 180000],
  ['Bridal & groom', 'Bridal makeup', 'women', 120, 800000],
  ['Bridal & groom', 'Groom package', 'men', 90, 350000],
  ['Combos', 'Haircut + beard trim', 'men', 45, 40000],
  ['Combos', 'Haircut + wash & blow-dry', 'all', 50, 50000],
  ['Combos', 'Cleanup + facial', 'all', 90, 140000],
];
