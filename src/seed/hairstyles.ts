export type Shape = 'Heart' | 'Oblong' | 'Oval' | 'Round' | 'Square';
export type StyleAudience = 'men' | 'women' | 'unisex';
export type Length = 'short' | 'medium' | 'long';
export type Maint = 'low' | 'medium' | 'high';

export interface StyleRow {
  name: string;
  audience: StyleAudience;
  shapes: Shape[];
  length: Length;
  maintenance: Maint;
  tags: string[];
  description: string;
  /** names of service_templates this style maps to */
  services: string[];
}

const H: Shape = 'Heart', B: Shape = 'Oblong', O: Shape = 'Oval', R: Shape = 'Round', S: Shape = 'Square';
const CUT = ['Haircut'];
const CUTSTYLE = ['Haircut', 'Styling'];

const s = (
  name: string, audience: StyleAudience, shapes: Shape[], length: Length, maintenance: Maint, tags: string[], description: string, services: string[] = CUT,
): StyleRow => ({ name, audience, shapes, length, maintenance, tags, description, services });

export const HAIRSTYLES: StyleRow[] = [
  // ---------------------------------------------------------------- men
  s('Classic Taper Fade', 'men', [O, R, S, H], 'short', 'medium', ['fade', 'clean', 'office'], 'Short sides blending smoothly into a slightly longer top. Sharp and easy to wear to work.'),
  s('Skin Fade with Textured Top', 'men', [O, R, S], 'short', 'high', ['fade', 'textured', 'modern'], 'Skin-tight sides with a messy, textured crop on top. Adds height that slims a rounder face.', CUTSTYLE),
  s('Pompadour', 'men', [O, R, S, H], 'medium', 'high', ['volume', 'retro', 'styling'], 'Swept-up volume at the front with short sides. Height on top lengthens a round face.', CUTSTYLE),
  s('Quiff', 'men', [O, R, S, B], 'medium', 'medium', ['volume', 'versatile'], 'A softer, shorter cousin of the pompadour with natural lift at the fringe.', CUTSTYLE),
  s('Side Part', 'men', [O, S, B, H], 'short', 'low', ['classic', 'formal', 'clean'], 'A neat parted cut that works for office, weddings and everything in between.'),
  s('Crew Cut', 'men', [O, S, R], 'short', 'low', ['low-maintenance', 'sporty'], 'Short all round with slightly more length at the front. Wash-and-go.'),
  s('Buzz Cut', 'men', [O, S], 'short', 'low', ['low-maintenance', 'minimal'], 'One even clipper length all over. Suits strong jawlines and balanced features.'),
  s('Ivy League', 'men', [O, S, B], 'short', 'low', ['classic', 'student'], 'A longer crew cut that can be parted or brushed to the side.'),
  s('Textured Crop', 'men', [O, S, H, B], 'short', 'medium', ['textured', 'fringe', 'modern'], 'Cropped fringe with choppy texture; the fringe balances a long or narrow face.', CUTSTYLE),
  s('French Crop', 'men', [O, S, B], 'short', 'low', ['fringe', 'easy'], 'Short blunt fringe over a faded back and sides. Easy daily styling.'),
  s('Undercut', 'men', [O, R, S], 'medium', 'medium', ['contrast', 'bold'], 'Disconnected short sides with long top that can be slicked back or swept.', CUTSTYLE),
  s('Slick Back', 'men', [O, S, R], 'medium', 'medium', ['formal', 'glossy'], 'Hair combed back with product for a polished, confident finish.', CUTSTYLE),
  s('Faux Hawk', 'men', [R, O, S], 'short', 'medium', ['volume', 'edgy'], 'Centre ridge of height with tapered sides; lengthens round faces.', CUTSTYLE),
  s('Curtain Hair', 'men', [B, O, S], 'medium', 'medium', ['90s', 'curls', 'fringe'], 'Centre-parted fringe falling to both sides. Adds width to a long face.'),
  s('Medium Flow', 'men', [O, B, S, H], 'medium', 'medium', ['natural', 'waves'], 'Collar-length layers that move naturally. Frames the face softly.'),
  s('Long Hair with Layers', 'men', [O, S, H], 'long', 'high', ['long', 'layers'], 'Shoulder-length layers for men; needs regular conditioning and trims.', ['Haircut', 'Hair spa']),
  s('Man Bun', 'men', [O, S, R, H], 'long', 'medium', ['long', 'tied'], 'Long hair gathered in a top or low knot with tight sides if desired.'),
  s('Curly Top Fade', 'men', [O, S, R, H], 'short', 'medium', ['curls', 'fade'], 'Defined natural curls on top with a clean fade at the sides.', CUTSTYLE),
  s('Spiky Hair', 'men', [O, S, R], 'short', 'medium', ['youth', 'styling'], 'Short spikes with gel; energetic look that adds height.', CUTSTYLE),
  s('Comb Over Fade', 'men', [O, S, R, B], 'short', 'medium', ['classic', 'fade'], 'Hard part with a combed-over top and fade. Sharp for formal occasions.'),
  s('Bald Fade with Beard', 'men', [O, S, R], 'short', 'medium', ['beard', 'bold'], 'Shaved head paired with a shaped beard that adds definition.', ['Haircut', 'Beard styling']),
  s('Short Beard with Taper', 'men', [R, O, B, H], 'short', 'medium', ['beard', 'sharp'], 'A tapered cut with a close-trimmed beard that gives structure to a softer jaw.', ['Haircut', 'Beard trim']),
  s('Mid Fade with Full Beard', 'men', [O, S, B], 'short', 'high', ['beard', 'fade'], 'A mid fade with a full, well-lined beard for a rugged but groomed look.', ['Haircut', 'Beard styling']),
  s('Classic Clean Shave and Cut', 'men', [O, S, R, B, H], 'short', 'low', ['clean', 'groom'], 'A neat haircut finished with a clean shave. Popular before events.', ['Haircut', 'Clean shave']),
  s('Groom Look', 'men', [O, S, R, B, H], 'medium', 'medium', ['wedding', 'groom'], 'Polished cut with styling and beard shaping for the wedding day.', ['Haircut', 'Styling', 'Beard styling']),
  s('Kids Short Crop', 'men', [O, R, S, B, H], 'short', 'low', ['kids', 'easy'], 'Simple short cut for boys; quick to maintain between school days.', ['Kids haircut']),

  // -------------------------------------------------------------- women
  s('Long Layers', 'women', [O, S, R, H, B], 'long', 'medium', ['layers', 'classic'], 'Soft layers through long hair add movement and take away weight. Flatters nearly every shape.', ['Haircut', 'Hair wash & blow-dry']),
  s('Face-Framing Layers', 'women', [R, S, B, O], 'long', 'medium', ['layers', 'framing'], 'Shorter pieces around the face to slim a round face or soften a square jaw.', ['Haircut', 'Hair wash & blow-dry']),
  s('Blunt Bob', 'women', [O, H, B], 'short', 'medium', ['bob', 'sleek'], 'One-length bob at the jaw. Adds width to oblong faces and balances a heart-shaped chin.', ['Haircut', 'Hair wash & blow-dry']),
  s('Long Bob (Lob)', 'women', [O, R, S, H], 'medium', 'low', ['bob', 'versatile'], 'Collarbone-grazing bob that is easy to tie back and flattering on most faces.', ['Haircut', 'Hair wash & blow-dry']),
  s('Angled Bob', 'women', [O, R, S], 'short', 'medium', ['bob', 'angled'], 'Shorter at the back and longer toward the front; lengthens a round face.', ['Haircut', 'Hair wash & blow-dry']),
  s('Layered Bob', 'women', [O, S, H, B], 'short', 'medium', ['bob', 'volume'], 'Bob with internal layers for bounce and body on fine hair.', ['Haircut', 'Hair wash & blow-dry']),
  s('Pixie Cut', 'women', [O, H, S], 'short', 'high', ['short', 'bold'], 'Cropped and feminine; highlights cheekbones and eyes. Needs trims every 4-5 weeks.', ['Haircut', 'Styling']),
  s('Textured Pixie', 'women', [O, H, S, R], 'short', 'medium', ['short', 'texture'], 'A pixie with choppy layers on top for volume and movement.', ['Haircut', 'Styling']),
  s('Curtain Bangs', 'women', [B, O, S, H], 'medium', 'medium', ['fringe', 'trending'], 'Parted bangs that sweep to the sides; soften a long face and a strong forehead.', ['Haircut', 'Styling']),
  s('Side-Swept Bangs', 'women', [H, B, R, O], 'medium', 'medium', ['fringe', 'soft'], 'A long, diagonal fringe that slims a wide forehead and balances the jaw.', ['Haircut', 'Styling']),
  s('Blunt Fringe', 'women', [O, B], 'medium', 'high', ['fringe', 'bold'], 'Straight-across bangs that shorten a long face; needs frequent trims.', ['Haircut', 'Styling']),
  s('Shag Cut', 'women', [O, H, B, S], 'medium', 'medium', ['shag', 'textured'], 'Choppy layers with a fringe for a lived-in, rock-and-roll finish.', ['Haircut', 'Styling']),
  s('Wolf Cut', 'women', [O, H, B], 'medium', 'medium', ['trending', 'volume'], 'A mix of shag and mullet with lots of volume on top and wispy ends.', ['Haircut', 'Styling']),
  s('Beach Waves', 'women', [O, S, B, H, R], 'long', 'medium', ['waves', 'casual'], 'Loose, tousled waves that soften angular features and add width to a long face.', ['Hair wash & blow-dry', 'Styling']),
  s('Soft Curls', 'women', [O, B, H, S], 'long', 'high', ['curls', 'party'], 'Bouncy curls with volume at the ends; add width for oblong faces.', ['Hair wash & blow-dry', 'Styling']),
  s('Sleek Straight', 'women', [O, H, S], 'long', 'medium', ['straight', 'glossy'], 'Pin-straight, glossy hair. Often paired with smoothening for lasting results.', ['Haircut', 'Keratin / smoothening']),
  s('High Ponytail', 'women', [O, S, H, B], 'long', 'low', ['updo', 'sporty'], 'Pulled up and away from the face; elongating and bold on strong jaws.', ['Styling']),
  s('Low Bun', 'women', [O, R, S, H, B], 'long', 'low', ['updo', 'formal'], 'A neat low bun that works for office, weddings and festive occasions.', ['Styling']),
  s('Messy Top Knot', 'women', [O, S, B, H], 'long', 'low', ['updo', 'casual'], 'Relaxed high knot with loose strands; adds height that lengthens round faces.', ['Styling']),
  s('French Braid', 'women', [O, R, S, H, B], 'long', 'medium', ['braid', 'traditional'], 'A classic braid starting at the crown; neat, secure and long-lasting.', ['Styling']),
  s('Side Braid', 'women', [O, R, H, B], 'long', 'medium', ['braid', 'soft'], 'A loose braid draped over one shoulder; softens a square or heart-shaped face.', ['Styling']),
  s('Bridal Updo', 'women', [O, R, S, H, B], 'long', 'high', ['wedding', 'updo'], 'Elegant sculpted updo for the big day; always book a trial.', ['Styling', 'Bridal makeup']),
  s('Half-Up Half-Down', 'women', [O, R, S, H, B], 'long', 'low', ['half-up', 'party'], 'Top section pinned back and the rest flowing; flattering on nearly everyone.', ['Styling']),
  s('Butterfly Cut', 'women', [O, R, H, S], 'long', 'medium', ['layers', 'trending'], 'Long face-framing layers with shorter top layers for a voluminous, airy look.', ['Haircut', 'Hair wash & blow-dry']),
  s('U-Cut', 'women', [O, R, S, H, B], 'long', 'low', ['simple', 'classic'], 'Rounded, U-shaped back with a few layers; simple and easy to manage.', ['Haircut']),
  s('V-Cut Layers', 'women', [O, B, R], 'long', 'medium', ['layers', 'long'], 'V-shaped back that draws attention to the length, with layers through the sides.', ['Haircut']),
  s('Balayage Waves', 'women', [O, R, S, H, B], 'long', 'high', ['colour', 'waves'], 'Hand-painted, sun-kissed highlights over soft waves. Low regrowth lines.', ['Hair colour', 'Highlights', 'Styling']),
  s('Caramel Highlights', 'women', [O, R, S, H, B], 'medium', 'medium', ['colour', 'highlights'], 'Warm caramel streaks that brighten skin and add dimension.', ['Highlights', 'Hair wash & blow-dry']),
  s('Burgundy Colour', 'women', [O, S, H], 'medium', 'high', ['colour', 'bold'], 'Deep wine-red tone that looks rich under all lighting.', ['Hair colour', 'Hair spa']),
  s('Chin-Length Bob with Bangs', 'women', [H, B, O], 'short', 'medium', ['bob', 'fringe'], 'Chin-length bob with a fringe that adds fullness at the jawline.', ['Haircut', 'Styling']),
  s('Asymmetrical Bob', 'women', [O, S, R], 'short', 'high', ['bob', 'bold'], 'One side longer than the other for a fashion-forward statement.', ['Haircut', 'Styling']),
  s('Mid-Length Waves', 'women', [O, H, B, S], 'medium', 'medium', ['waves', 'everyday'], 'Shoulder-length hair with gentle waves for added body.', ['Hair wash & blow-dry', 'Styling']),
  s('Smooth Blowout', 'women', [O, R, S, B, H], 'medium', 'medium', ['blowout', 'party'], 'Bouncy, voluminous blow-dry that lasts several days.', ['Hair wash & blow-dry']),
  s('Kids Bob', 'women', [O, R, S, B, H], 'short', 'low', ['kids', 'easy'], 'Simple chin-length bob for girls; easy to manage for school.', ['Kids haircut']),

  // ------------------------------------------------------------- unisex
  s('Natural Curls Enhancement', 'unisex', [O, B, H, S], 'medium', 'medium', ['curls', 'natural'], 'Shape and moisturise natural curls so they stay defined and frizz-free.', ['Haircut', 'Hair spa']),
  s('Layered Shag (Unisex)', 'unisex', [O, H, B], 'medium', 'medium', ['shag', 'textured'], 'Choppy layers and a flowing fringe that work on any hair type.', ['Haircut', 'Styling']),
  s('Fringe with Taper', 'unisex', [B, O, S, H], 'short', 'medium', ['fringe', 'modern'], 'Short sides with a longer fringe that can be pushed forward or swept.', ['Haircut', 'Styling']),
  s('Buzz with Design Line', 'unisex', [O, S], 'short', 'high', ['buzz', 'design'], 'Close crop with a shaved line or pattern. Bold and low on styling time.', ['Haircut']),
  s('Mullet (Modern)', 'unisex', [O, H, B, S], 'medium', 'medium', ['trending', 'edgy'], 'Short at the front and sides, longer at the back. A statement with lots of texture.', ['Haircut', 'Styling']),
  s('Bowl-Free Bob (Unisex)', 'unisex', [O, B, S], 'short', 'low', ['bob', 'minimal'], 'Soft chin-length cut with no hard lines; simple and gender-neutral.', ['Haircut']),
  s('Half-Shaved Undercut', 'unisex', [O, S, R], 'medium', 'high', ['bold', 'undercut'], 'One side shaved close with the top left long. A strong contrast look.', ['Haircut', 'Styling']),
  s('Long Straight with Middle Part', 'unisex', [O, R, S, H], 'long', 'low', ['long', 'minimal'], 'Simple centre-parted long hair; keep ends healthy with regular trims.', ['Haircut']),
  s('Dreadlock Maintenance', 'unisex', [O, R, S, B, H], 'long', 'high', ['locs', 'protective'], 'Retwisting and cleaning of locs to keep them tidy and healthy.', ['Styling']),
  s('Platinum Blonde', 'unisex', [O, S, H], 'medium', 'high', ['colour', 'bold'], 'Lift to a pale blonde with toner; plan for aftercare and repair treatments.', ['Hair colour', 'Hair spa']),
  s('Pastel Colour', 'unisex', [O, R, H, S, B], 'medium', 'high', ['colour', 'creative'], 'Soft pink, lilac or blue tones for a playful look; fades in a few weeks.', ['Hair colour']),
  s('Scalp-Care Short Cut', 'unisex', [O, R, S, B, H], 'short', 'low', ['scalp', 'care'], 'Easy short cut combined with a scalp treatment for dandruff-prone hair.', ['Haircut', 'Scalp treatment']),
  s('Smooth and Straight Keratin', 'unisex', [O, R, S, B, H], 'medium', 'low', ['smoothening', 'frizz'], 'Keratin smoothing that tames frizz for months and shortens styling time.', ['Keratin / smoothening']),
];
