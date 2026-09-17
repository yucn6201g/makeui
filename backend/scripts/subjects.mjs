/**
 * What the library is allowed to be about.
 *
 * The previous taxonomy had seven entries — office, people, workspace, city,
 * nature, abstract, product — and that coarseness was the whole defect. A
 * storefront selling butter asked for "product", got a photograph of a shelf,
 * and every T-shirt on the page was illustrated with an office desk. No amount
 * of cleverness in the matcher recovers from a library that does not contain
 * the subject; the fix has to start here.
 *
 * So the unit is the SUBJECT, not the category. `butter` is a subject. The
 * category above it exists only for the restraint rules (at most two scenery
 * shots on a page) and for the S3 layout.
 *
 * Queries are English because Openverse's metadata is. The Japanese a brief is
 * written in is bridged in stock-images.ts, deliberately on the other side of
 * the wire: the vocabulary a user might type changes far more often than the
 * pictures do, and re-curating six hundred images to add the word "バター" would
 * be absurd.
 */
export const SUBJECTS = {
  // ---- food and drink ---------------------------------------------------
  butter: { category: 'food', queries: ['butter block dairy', 'butter dish', 'butter slab board', 'butter knife spread'] },
  cheese: { category: 'food', queries: ['cheese wheel', 'cheese board'] },
  milk: { category: 'food', queries: ['milk bottle glass', 'milk carton', 'milk glass bottle white', 'dairy milk jug'] },
  egg: { category: 'food', queries: ['eggs carton', 'fresh eggs basket', 'eggs bowl white', 'egg carton close up'] },
  bread: { category: 'food', queries: ['bread loaf bakery', 'baguette bakery'] },
  cake: { category: 'food', queries: ['cake slice dessert', 'birthday cake'] },
  chocolate: { category: 'food', queries: ['chocolate bar', 'chocolate pieces'] },
  fruit: { category: 'food', queries: ['fresh fruit basket', 'apples oranges'] },
  vegetable: { category: 'food', queries: ['fresh vegetables market', 'salad vegetables'] },
  meat: { category: 'food', queries: ['raw meat cut', 'steak plate', 'meat cuts butcher', 'beef steak raw board'] },
  fish: { category: 'food', queries: ['fresh fish market', 'seafood plate'] },
  rice: { category: 'food', queries: ['rice bowl grain', 'rice field harvest', 'rice grains bowl white', 'cooked rice plate'] },
  noodle: { category: 'food', queries: ['noodles bowl', 'pasta dish'] },
  honey: { category: 'food', queries: ['honey jar', 'honeycomb'] },
  spice: { category: 'food', queries: ['spices bowls', 'herbs spices'] },
  coffee: { category: 'drink', queries: ['coffee cup beans', 'espresso cup'] },
  tea: { category: 'drink', queries: ['tea cup leaves', 'teapot tea'] },
  wine: { category: 'drink', queries: ['wine glass bottle', 'red wine'] },
  beer: { category: 'drink', queries: ['beer glass', 'craft beer bottles', 'beer bottles row', 'beer tap bar'] },
  juice: { category: 'drink', queries: ['fruit juice glass', 'orange juice'] },
  water: { category: 'drink', queries: ['water bottle', 'glass of water'] },

  // ---- apparel ----------------------------------------------------------
  tshirt: { category: 'apparel', queries: ['t-shirt plain', 'folded t-shirts', 'plain white t-shirt mockup', 'tshirt hanging rack'] },
  shirt: { category: 'apparel', queries: ['dress shirt hanger', 'shirt folded', 'shirts on hangers rack', 'white shirt folded table'] },
  knitwear: { category: 'apparel', queries: ['knitted sweater', 'wool sweater', 'folded knitted jumper', 'sweater flat lay'] },
  jeans: { category: 'apparel', queries: ['denim jeans', 'jeans folded', 'jeans stack denim', 'denim trousers flat lay'] },
  dress: { category: 'apparel', queries: ['dress fashion', 'summer dress'] },
  coat: { category: 'apparel', queries: ['winter coat', 'jacket hanging'] },
  shoes: { category: 'apparel', queries: ['leather shoes pair', 'shoes display'] },
  sneakers: { category: 'apparel', queries: ['sneakers pair', 'running shoes', 'sneakers white studio', 'trainers pair shoes'] },
  bag: { category: 'apparel', queries: ['leather bag', 'handbag'] },
  hat: { category: 'apparel', queries: ['hat cap', 'straw hat', 'cap hat display', 'felt hat table'] },
  watch: { category: 'apparel', queries: ['wrist watch', 'watch close up'] },
  jewellery: { category: 'apparel', queries: ['jewellery rings', 'necklace'] },
  scarf: { category: 'apparel', queries: ['scarf textile', 'wool scarf'] },
  fabric: { category: 'apparel', queries: ['fabric texture textile', 'folded fabric'] },

  // ---- electronics ------------------------------------------------------
  laptop: { category: 'electronics', queries: ['laptop computer desk', 'open laptop'] },
  smartphone: { category: 'electronics', queries: ['smartphone in hand', 'mobile phone'] },
  headphones: { category: 'electronics', queries: ['headphones', 'earphones'] },
  camera: { category: 'electronics', queries: ['camera lens', 'photo camera'] },
  keyboard: { category: 'electronics', queries: ['computer keyboard', 'mechanical keyboard', 'keyboard desk workspace', 'wireless keyboard mouse'] },
  monitor: { category: 'electronics', queries: ['computer monitor desk', 'display screen'] },
  speaker: { category: 'electronics', queries: ['speaker audio', 'bluetooth speaker'] },
  tablet: { category: 'electronics', queries: ['tablet device', 'tablet in hand'] },
  cable: { category: 'electronics', queries: ['cables connectors', 'usb cable', 'charging cable white', 'power adapter cable desk'] },

  // ---- home and interior ------------------------------------------------
  sofa: { category: 'home', queries: ['sofa living room', 'couch interior'] },
  chair: { category: 'home', queries: ['wooden chair', 'chair interior'] },
  table: { category: 'home', queries: ['wooden table', 'dining table'] },
  lamp: { category: 'home', queries: ['table lamp', 'pendant lamp'] },
  bed: { category: 'home', queries: ['bed bedroom', 'made bed linen', 'bedroom interior bed', 'hotel bed white linen'] },
  cushion: { category: 'home', queries: ['cushion pillow', 'sofa cushions'] },
  rug: { category: 'home', queries: ['rug carpet floor', 'woven rug'] },
  tableware: { category: 'home', queries: ['plates ceramic', 'tableware setting'] },
  kitchenware: { category: 'home', queries: ['kitchen utensils', 'cooking pot'] },
  candle: { category: 'home', queries: ['candle light', 'scented candle'] },
  towel: { category: 'home', queries: ['folded towels', 'bath towel', 'towels stacked bathroom', 'rolled towels spa'] },
  plant: { category: 'home', queries: ['potted plant indoor', 'houseplant'] },
  flower: { category: 'home', queries: ['flower bouquet', 'flowers vase'] },

  // ---- beauty -----------------------------------------------------------
  cosmetics: { category: 'beauty', queries: ['cosmetics makeup', 'lipstick makeup'] },
  skincare: { category: 'beauty', queries: ['skincare bottle', 'cream jar cosmetic', 'serum bottle skincare', 'moisturiser jar white'] },
  perfume: { category: 'beauty', queries: ['perfume bottle', 'fragrance bottle'] },
  soap: { category: 'beauty', queries: ['soap bar', 'handmade soap', 'soap bars stacked', 'liquid soap dispenser'] },
  haircare: { category: 'beauty', queries: ['shampoo bottle', 'hair care products', 'shampoo conditioner bottles', 'hair salon products shelf'] },

  // ---- leisure ----------------------------------------------------------
  book: { category: 'leisure', queries: ['stack of books', 'open book'] },
  toy: { category: 'leisure', queries: ['wooden toys', 'children toys'] },
  bicycle: { category: 'leisure', queries: ['bicycle', 'bike city'] },
  camping: { category: 'leisure', queries: ['camping tent', 'campsite outdoor', 'tent forest camping', 'camping gear outdoor table'] },
  yoga: { category: 'leisure', queries: ['yoga mat exercise', 'yoga pose'] },
  gym: { category: 'leisure', queries: ['gym equipment', 'dumbbells gym'] },
  ball: { category: 'leisure', queries: ['soccer ball field', 'basketball court'] },
  music: { category: 'leisure', queries: ['guitar instrument', 'piano keys', 'acoustic guitar close', 'music studio equipment'] },
  dog: { category: 'leisure', queries: ['dog portrait', 'dog outdoors', 'dog sitting studio', 'puppy portrait white background'] },
  cat: { category: 'leisure', queries: ['cat portrait', 'cat resting'] },

  // ---- stationery -------------------------------------------------------
  notebook: { category: 'stationery', queries: ['notebook pen desk', 'open notebook'] },
  pen: { category: 'stationery', queries: ['fountain pen', 'pens desk'] },
  paper: { category: 'stationery', queries: ['paper documents', 'blank paper sheets', 'stack of paper documents', 'printed documents desk'] },
  envelope: { category: 'stationery', queries: ['envelopes letters', 'mail envelope'] },

  // ---- workplaces and operations ---------------------------------------
  office: { category: 'scene', queries: ['office desk interior', 'modern office'] },
  meeting: { category: 'scene', queries: ['business meeting room', 'colleagues meeting'] },
  warehouse: { category: 'scene', queries: ['warehouse shelves', 'warehouse storage'] },
  factory: { category: 'scene', queries: ['factory production line', 'industrial machinery'] },
  construction: { category: 'scene', queries: ['construction site', 'building construction'] },
  shop: { category: 'scene', queries: ['retail shop interior', 'store shelves'] },
  restaurant: { category: 'scene', queries: ['restaurant interior', 'dining restaurant'] },
  cafe: { category: 'scene', queries: ['cafe interior', 'coffee shop'] },
  hospital: { category: 'scene', queries: ['hospital corridor', 'medical clinic'] },
  school: { category: 'scene', queries: ['classroom school', 'lecture hall'] },
  farm: { category: 'scene', queries: ['farm field', 'agriculture farming'] },
  logistics: { category: 'scene', queries: ['delivery truck', 'shipping containers'] },
  parcel: { category: 'scene', queries: ['cardboard boxes parcel', 'packages delivery', 'parcel boxes stacked', 'shipping box tape'] },
  laboratory: { category: 'scene', queries: ['laboratory science', 'lab equipment'] },
  workshop: { category: 'scene', queries: ['workshop tools bench', 'craftsman workshop', 'woodworking workshop bench', 'tool wall workshop'] },

  // ---- places -----------------------------------------------------------
  city: { category: 'place', queries: ['city street buildings', 'urban skyline'] },
  building: { category: 'place', queries: ['building facade', 'office building exterior'] },
  house: { category: 'place', queries: ['house exterior', 'residential home'] },
  apartment: { category: 'place', queries: ['apartment building', 'apartment interior'] },
  hotel: { category: 'place', queries: ['hotel room', 'hotel lobby'] },
  beach: { category: 'place', queries: ['beach sea', 'coast shore'] },
  mountain: { category: 'place', queries: ['mountain landscape', 'mountains valley'] },
  forest: { category: 'place', queries: ['forest trees', 'forest path'] },
  park: { category: 'place', queries: ['city park', 'park bench trees'] },
  road: { category: 'place', queries: ['road highway', 'countryside road'] },
  train: { category: 'place', queries: ['train railway', 'train station'] },
  airport: { category: 'place', queries: ['airport terminal', 'airplane wing'] },

  // ---- people -----------------------------------------------------------
  portrait: { category: 'people', queries: ['portrait person neutral', 'professional headshot', 'business portrait smiling', 'profile photo person office', 'headshot woman professional', 'headshot man professional'] },
  team: { category: 'people', queries: ['business team', 'colleagues working'] },
  worker: { category: 'people', queries: ['worker helmet site', 'factory worker', 'warehouse worker scanning', 'engineer working machine'] },
  chef: { category: 'people', queries: ['chef cooking kitchen', 'cook preparing food'] },
  doctor: { category: 'people', queries: ['doctor medical', 'nurse hospital'] },
  student: { category: 'people', queries: ['student studying', 'students campus'] },
  customer: { category: 'people', queries: ['customer shopping', 'shopper store'] },

  // ---- surfaces ---------------------------------------------------------
  texture: { category: 'abstract', queries: ['abstract texture', 'concrete wall texture'] },
  wood: { category: 'abstract', queries: ['wood grain texture', 'wooden surface'] },
  marble: { category: 'abstract', queries: ['marble texture', 'stone surface'] },
  gradient: { category: 'abstract', queries: ['gradient background', 'soft colour background', 'smooth colour gradient', 'abstract soft background blur'] },
  pattern: { category: 'abstract', queries: ['geometric pattern', 'repeating pattern'] },
};
