/**
 * What a thing has to be called for us to know what it is.
 *
 * The library is collected in English, from an English-language API, and every
 * brief this product receives is in Japanese. Nothing bridges those two on its
 * own: a photographer tags a picture "butter", and no amount of scoring gets
 * from 「カルピスバター」 to that tag without being told.
 *
 * This lives on the runtime side rather than in the curation script on purpose.
 * The pictures change when someone re-curates, which is rare; the words a user
 * might type change constantly. Adding 「バタ」 as a synonym should not require
 * re-downloading six hundred photographs.
 *
 * Keys must exist in scripts/subjects.mjs. A key that does not simply never
 * matches anything, which is harmless but pointless — the test asserts they
 * agree.
 */
export const SUBJECT_TERMS: Record<string, string[]> = {
  // ---- food and drink ---------------------------------------------------
  butter: ['バター', 'butter', 'マーガリン'],
  cheese: ['チーズ', 'cheese', 'カマンベール', 'モッツァレラ'],
  milk: ['牛乳', 'ミルク', 'milk', '乳製品'],
  egg: ['たまご', '卵', 'タマゴ', 'egg'],
  /**
   * The compounds are spelled out because Japanese puts the head noun last and
   * the matcher prefers the longest term.
   *
   * Measured on a real dairy shop: 「バターロール」 and 「チーズパン」 were given
   * photographs of butter and cheese, because 「バター」 is three characters and
   * 「パン」 is two. They are bread. Listing the compound makes the longest match
   * the correct one, which is the mechanism already in use rather than a new
   * rule — a general "head noun wins" would take 「コーヒーカップ」 away from
   * coffee, and that one is genuinely ambiguous.
   */
  bread: ['バターロール', 'クロワッサン', 'メロンパン', 'カレーパン', 'ロールパン',
    'チーズパン', 'ミルクパン', 'あんぱん', '食パン', 'バゲット', 'ベーカリー', 'パン', 'bread'],
  cake: ['ケーキ', 'cake', 'スイーツ', 'デザート', 'dessert', 'プリン', 'タルト'],
  chocolate: ['チョコ', 'chocolate', 'ショコラ'],
  fruit: ['果物', 'フルーツ', 'fruit', 'りんご', 'みかん', 'バナナ', 'いちご', 'ぶどう'],
  vegetable: ['野菜', 'vegetable', 'サラダ', 'salad', 'トマト', 'にんじん', 'キャベツ'],
  meat: ['肉', 'meat', '牛肉', '豚肉', '鶏肉', 'ステーキ', 'ハム', 'ソーセージ'],
  fish: ['魚', 'fish', '鮮魚', '刺身', '海鮮', 'seafood', 'サーモン'],
  // 「米」 alone is 米国 and 欧米 as often as it is rice.
  rice: ['ごはん', 'ライス', 'rice', '玄米', '白米', 'お米', 'おにぎり'],
  noodle: ['麺', 'ラーメン', 'うどん', 'そば', 'パスタ', 'pasta', 'noodle'],
  honey: ['はちみつ', '蜂蜜', 'honey'],
  spice: ['スパイス', '香辛料', 'spice', 'ハーブ', 'herb', '調味料'],
  coffee: ['コーヒー', 'coffee', 'エスプレッソ', 'カフェラテ', 'ドリップ'],
  tea: ['茶', 'ティー', 'tea', '紅茶', '緑茶', 'ほうじ茶'],
  wine: ['ワイン', 'wine', 'シャンパン'],
  beer: ['ビール', 'beer', 'エール'],
  juice: ['ジュース', 'juice', 'スムージー'],
  water: ['水', 'ミネラルウォーター', 'water', '飲料水'],

  // ---- apparel ----------------------------------------------------------
  tshirt: ['tシャツ', 'ｔシャツ', 't-shirt', 'tee', 'カットソー'],
  shirt: ['シャツ', 'shirt', 'ブラウス', 'blouse'],
  knitwear: ['ニット', 'セーター', 'sweater', 'knit', 'カーディガン', 'パーカー', 'hoodie'],
  jeans: ['ジーンズ', 'デニム', 'jeans', 'denim', 'パンツ', 'ズボン', 'trousers'],
  dress: ['ワンピース', 'ドレス', 'dress', 'スカート', 'skirt'],
  coat: ['コート', 'coat', 'ジャケット', 'jacket', 'アウター', 'ブルゾン'],
  shoes: ['靴', 'shoes', 'ブーツ', 'boots', 'パンプス', 'サンダル', 'ローファー'],
  sneakers: ['スニーカー', 'sneaker', 'ランニングシューズ', '運動靴'],
  bag: ['バッグ', 'かばん', '鞄', 'bag', 'リュック', 'トート', '財布', 'wallet'],
  hat: ['帽子', 'hat', 'キャップ', 'cap', 'ハット'],
  watch: ['腕時計', 'watch', 'ウォッチ'],
  /**
   * 「リング」 is not here, and must not be added back.
   *
   * It is a substring of リファクタリング, フィルタリング, モニタリング and
   * エンジニアリング — measured, a book titled 「技術書 リファクタリング」 was
   * matched as jewellery. Katakana loanwords collide constantly, so a term has
   * to be long enough to be unambiguous on its own.
   */
  jewellery: ['アクセサリー', 'ジュエリー', 'jewel', 'ネックレス', '指輪', 'ピアス', 'イヤリング', 'ブレスレット'],
  scarf: ['マフラー', 'ストール', 'スカーフ', 'scarf'],
  fabric: ['生地', 'テキスタイル', 'textile', 'fabric', '布'],

  // ---- electronics ------------------------------------------------------
  laptop: ['ノートpc', 'ノートパソコン', 'laptop', 'パソコン', 'pc', 'macbook'],
  smartphone: ['スマホ', 'スマートフォン', 'smartphone', '携帯', 'iphone', 'android'],
  headphones: ['ヘッドホン', 'ヘッドフォン', 'イヤホン', 'イヤフォン', 'headphone', 'earphone', 'earbud'],
  camera: ['カメラ', 'camera', '一眼', 'レンズ'],
  keyboard: ['キーボード', 'keyboard', 'マウス', 'mouse'],
  monitor: ['モニター', 'ディスプレイ', 'monitor', 'display'],
  speaker: ['スピーカー', 'speaker', 'オーディオ', 'audio'],
  tablet: ['タブレット', 'tablet', 'ipad'],
  cable: ['ケーブル', 'cable', '充電器', 'charger', 'アダプタ'],

  // ---- home and interior ------------------------------------------------
  sofa: ['ソファ', 'sofa', 'couch'],
  chair: ['椅子', 'チェア', 'chair', 'スツール'],
  // 「ダイニングテーブル」 spelled out, or `restaurant` wins it on 「ダイニング」
  // being the longer term — measured on an oak dining table.
  table: ['ダイニングテーブル', 'ローテーブル', 'テーブル', '机', 'desk', 'table'],
  lamp: ['ランプ', '照明', 'lamp', 'ライト', 'light'],
  bed: ['ベッド', 'bed', '寝具', '布団', 'マットレス'],
  cushion: ['クッション', 'cushion', 'まくら', '枕', 'pillow'],
  rug: ['ラグ', 'カーペット', 'rug', 'carpet', '絨毯'],
  tableware: ['食器', '皿', 'plate', 'tableware', 'カップ', 'マグ', 'mug', 'グラス'],
  kitchenware: ['キッチン', 'kitchen', '調理器具', 'なべ', '鍋', 'フライパン', '包丁'],
  candle: ['キャンドル', 'candle', 'アロマ'],
  towel: ['タオル', 'towel', 'バスタオル'],
  plant: ['観葉植物', 'plant', 'グリーン', '鉢'],
  flower: ['花', 'flower', 'ブーケ', '生花', 'フラワー'],

  // ---- beauty -----------------------------------------------------------
  cosmetics: ['化粧品', 'コスメ', 'cosmetic', 'メイク', 'makeup', '口紅', 'リップ', 'ファンデーション'],
  skincare: ['スキンケア', 'skincare', '化粧水', '美容液', 'クリーム', '乳液'],
  perfume: ['香水', 'perfume', 'フレグランス'],
  soap: ['石けん', '石鹸', 'soap', 'ソープ', 'ボディソープ'],
  haircare: ['シャンプー', 'shampoo', 'ヘアケア', 'トリートメント', 'コンディショナー'],

  // ---- leisure ----------------------------------------------------------
  /**
   * 「本」 alone is in 日本, 本日 and 本文.
   *
   * Worse than a wrong match: 「日本茶」 contains both 「本」 and 「茶」, both one
   * character, so which subject won depended on the order two equal-length
   * terms happened to land in after sorting. A rule whose result is a coin
   * flip is not a rule.
   */
  book: ['書籍', 'book', '絵本', '雑誌', '書店', '図書', '文庫', 'コミック'],
  toy: ['おもちゃ', '玩具', 'toy', '知育'],
  bicycle: ['自転車', 'bicycle', 'bike', 'サイクル'],
  camping: ['キャンプ', 'camping', 'テント', 'アウトドア', 'outdoor'],
  yoga: ['ヨガ', 'yoga', 'ピラティス', 'ストレッチ'],
  gym: ['ジム', 'gym', 'フィットネス', 'fitness', 'トレーニング', '筋トレ'],
  ball: ['サッカー', 'soccer', '野球', 'バスケ', 'basketball', 'ボール', 'スポーツ', 'sport'],
  music: ['音楽', 'music', 'ギター', 'guitar', 'ピアノ', 'piano', '楽器'],
  dog: ['犬', 'dog', 'いぬ', 'ドッグ', 'ペット', 'pet'],
  cat: ['猫', 'cat', 'ねこ', 'キャット'],

  // ---- stationery -------------------------------------------------------
  notebook: ['ノート', 'notebook', '手帳', 'メモ帳'],
  pen: ['ペン', 'pen', 'ボールペン', '万年筆', '鉛筆', '文房具', 'ステーショナリー'],
  paper: ['用紙', 'paper', '書類', '紙'],
  envelope: ['封筒', 'envelope', '郵便', 'はがき'],

  // ---- workplaces and operations ---------------------------------------
  office: ['オフィス', 'office', '社内', '事務所', 'デスク', '受付', 'ワークスペース'],
  meeting: ['会議', 'meeting', '打ち合わせ', 'ミーティング', '商談'],
  warehouse: ['倉庫', 'warehouse', '在庫', '物流センター', '備品'],
  factory: ['工場', 'factory', '製造', '生産ライン', 'プラント'],
  construction: ['建設', 'construction', '工事', '現場', '施工'],
  shop: ['店舗', 'shop', 'store', '売り場', '小売', 'ショップ'],
  restaurant: ['レストラン', 'restaurant', '飲食店', 'ダイニング'],
  cafe: ['カフェ', 'cafe', '喫茶'],
  hospital: ['病院', 'hospital', 'クリニック', '医療', '診療'],
  school: ['学校', 'school', '教室', '授業', '大学', '講義'],
  farm: ['農園', 'farm', '農業', '畑', '牧場'],
  logistics: ['配送', 'delivery', '輸送', 'トラック', 'truck', '物流'],
  parcel: ['荷物', '梱包', 'parcel', 'package', 'ダンボール', '発送'],
  laboratory: ['研究', 'laboratory', '実験', 'ラボ', '検査'],
  workshop: ['工房', 'workshop', '作業場', '工具', 'tool', 'diy'],

  // ---- places -----------------------------------------------------------
  city: ['街', '都市', 'city', '市街', '都心'],
  building: ['ビル', 'building', '建物', '施設'],
  // 「家」 alone is not here, for the same reason 「本」 is not: it is in 家具,
  // 家電, 実家, 作家 and 国家 before it is in a house. Measured — 「家具の
  // オンラインストア」 matched `house` and came back with photographs of
  // buildings, which also stopped the furniture category ever being consulted.
  house: ['住宅', 'house', '一戸建て', '戸建', 'マイホーム'],
  apartment: ['マンション', 'apartment', 'アパート', '賃貸', '物件', '不動産'],
  hotel: ['ホテル', 'hotel', '宿泊', '客室', '旅館'],
  // 「海」 alone is in 北海道, 海外, 上海 and 日本海 before it is in a beach.
  beach: ['beach', 'ビーチ', '海岸', '海辺', '砂浜', '海水浴'],
  // Same reason as road: 「山」 alone matches 岡山, 山田, 富山.
  mountain: ['mountain', '登山', '山岳', '山脈'],
  // 「林」 alone is in 林檎 and 小林.
  forest: ['森', 'forest', '森林', '自然', 'nature'],
  park: ['公園', 'park', '緑地'],
  // 「道」 alone is not here: 北海道 is in more Japanese product names than roads are.
  road: ['道路', 'road', '街道', '高速道路'],
  train: ['電車', 'train', '鉄道', '駅', 'station'],
  airport: ['空港', 'airport', '飛行機', '航空'],

  // ---- people -----------------------------------------------------------
  portrait: ['プロフィール', 'profile', '人物', 'portrait', '担当者', 'アバター'],
  team: ['チーム', 'team', 'メンバー', 'member', '社員', 'スタッフ', 'staff'],
  worker: ['作業員', 'worker', '職人', '技術者', '現場担当'],
  chef: ['シェフ', 'chef', '料理人', '調理'],
  doctor: ['医師', 'doctor', '看護', 'nurse', '医療従事者'],
  student: ['学生', 'student', '生徒', '受講'],
  customer: ['顧客', 'customer', 'お客', '来店', '購入者'],

  // ---- surfaces ---------------------------------------------------------
  texture: ['テクスチャ', 'texture', '質感'],
  wood: ['木目', 'wood', '木材', 'ウッド'],
  marble: ['大理石', 'marble', '石材'],
  gradient: ['グラデーション', 'gradient', '背景', 'background', 'ヒーロー', 'hero'],
  pattern: ['パターン', 'pattern', '模様'],
}

/**
 * The group each subject belongs to.
 *
 * Used for one thing only: the fallback when the library has nothing of a
 * subject it did recognise. Knowing the item is food means a photograph of
 * cheese is a picture of the right kind of thing, where a concrete wall is not.
 *
 * Kept here rather than read off the collected images because it is needed
 * exactly when there are no collected images of that subject to read it from.
 * It must agree with scripts/subjects.mjs, and the test asserts that it does.
 */
export const SUBJECT_CATEGORY: Record<string, string> = {
  butter: 'food', cheese: 'food', milk: 'food', egg: 'food', bread: 'food', cake: 'food',
  chocolate: 'food', fruit: 'food', vegetable: 'food', meat: 'food', fish: 'food', rice: 'food',
  noodle: 'food', honey: 'food', spice: 'food',
  coffee: 'drink', tea: 'drink', wine: 'drink', beer: 'drink', juice: 'drink', water: 'drink',
  tshirt: 'apparel', shirt: 'apparel', knitwear: 'apparel', jeans: 'apparel', dress: 'apparel',
  coat: 'apparel', shoes: 'apparel', sneakers: 'apparel', bag: 'apparel', hat: 'apparel',
  watch: 'apparel', jewellery: 'apparel', scarf: 'apparel', fabric: 'apparel',
  laptop: 'electronics', smartphone: 'electronics', headphones: 'electronics', camera: 'electronics',
  keyboard: 'electronics', monitor: 'electronics', speaker: 'electronics', tablet: 'electronics',
  cable: 'electronics',
  sofa: 'home', chair: 'home', table: 'home', lamp: 'home', bed: 'home', cushion: 'home',
  rug: 'home', tableware: 'home', kitchenware: 'home', candle: 'home', towel: 'home',
  plant: 'home', flower: 'home',
  cosmetics: 'beauty', skincare: 'beauty', perfume: 'beauty', soap: 'beauty', haircare: 'beauty',
  book: 'leisure', toy: 'leisure', bicycle: 'leisure', camping: 'leisure', yoga: 'leisure',
  gym: 'leisure', ball: 'leisure', music: 'leisure', dog: 'leisure', cat: 'leisure',
  notebook: 'stationery', pen: 'stationery', paper: 'stationery', envelope: 'stationery',
  office: 'scene', meeting: 'scene', warehouse: 'scene', factory: 'scene', construction: 'scene',
  shop: 'scene', restaurant: 'scene', cafe: 'scene', hospital: 'scene', school: 'scene',
  farm: 'scene', logistics: 'scene', parcel: 'scene', laboratory: 'scene', workshop: 'scene',
  city: 'place', building: 'place', house: 'place', apartment: 'place', hotel: 'place',
  beach: 'place', mountain: 'place', forest: 'place', park: 'place', road: 'place',
  train: 'place', airport: 'place',
  portrait: 'people', team: 'people', worker: 'people', chef: 'people', doctor: 'people',
  student: 'people', customer: 'people',
  texture: 'abstract', wood: 'abstract', marble: 'abstract', gradient: 'abstract', pattern: 'abstract',
}

/**
 * The subject a piece of text is about, or null.
 *
 * Longest term first, so 「ランニングシューズ」 resolves to sneakers rather than
 * to shoes and 「コーヒーカップ」 to coffee rather than to tableware. Ties are
 * not broken cleverly — a label that genuinely names two subjects has no right
 * answer, and picking the more specific one is the best available rule.
 *
 * Returns null far more often than it returns a subject, and that is the point.
 * The failure this replaces was a matcher that always found something: every
 * T-shirt on a storefront illustrated with a photograph of an office desk,
 * because "product" matched everything and meant nothing.
 */
/**
 * Words that name a thing when they label an item and something else entirely
 * when they appear in a specification.
 *
 * 「テーブル」 on a product is a piece of furniture; in a UI brief it is a data
 * table, and matching it there put photographs of dining tables into a clothing
 * shop — measured on a real run, which also picked `rice` and `dress` for the
 * same document. 「本」 is a book and also the first character of 本日 and 本文.
 * 「背景」 is a photograph subject and also the CSS property every design plan
 * discusses. `display` and `store` are English UI vocabulary before they are
 * monitors and shops.
 *
 * They stay in the table because an item actually called one of them must still
 * match. They are only skipped when the text being read is a brief or a design
 * plan rather than the name of a thing.
 */
const AMBIGUOUS_IN_BRIEF = new Set([
  'テーブル', 'table', '机', 'desk',
  'book',
  'ライト', 'light',
  '背景', 'background', 'ヒーロー', 'hero',
  'パターン', 'pattern',
  'display', 'monitor', 'モニター',
  'store', 'shop',
  'rice',
  '紙', '用紙', 'paper',
  '水', 'water',
])

const ORDERED: { subject: string; term: string }[] = Object.entries(SUBJECT_TERMS)
  .flatMap(([subject, terms]) => terms.map((term) => ({ subject, term: term.toLowerCase() })))
  .sort((a, b) => b.term.length - a.term.length)

/**
 * Words that CONTAIN a subject term while being something else entirely.
 *
 * Japanese has no spaces, so a substring match reads 「サングラス」 as 「グラス」 and
 * files a pair of sunglasses under tableware — measured on a real apparel
 * storefront, where it was the one wrong photograph among twelve right ones.
 * The same trap holds for a handful of other compounds.
 *
 * A term is ignored when the only place it occurs is inside one of these. The
 * name then goes on to the model-backed resolver, which answers with a subject
 * the library really holds or with nothing — and nothing is the correct answer
 * for sunglasses, because the library has no photograph of any.
 */
const COMPOUNDS_THAT_SWALLOW_A_TERM = [
  'サングラス', 'ワイングラス', 'グラスウール',
  'ブックカバー', 'ノートパソコン', 'デスクトップ',
  'ペンダント', 'ペンキ', 'カメラマン', 'バッグパック',
]

/** True when `term` occurs in `text` only as part of a longer word that is not it. */
function onlyInsideCompound(text: string, term: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at === -1) return true
    const swallowed = COMPOUNDS_THAT_SWALLOW_A_TERM.some((word) => {
      const lower = word.toLowerCase()
      // A term that IS the compound is the word itself, not a word swallowing it:
      // 「ノートパソコン」 is a term for `laptop` and also contains 「ノート」.
      if (lower === term || !lower.includes(term)) return false
      const start = at - lower.indexOf(term)
      return text.slice(start, start + lower.length) === lower
    })
    if (!swallowed) return false
    from = at + 1
  }
}

export function matchSubject(text: string): string | null {
  if (!text) return null
  const t = text.toLowerCase()
  for (const { subject, term } of ORDERED) {
    if (!t.includes(term)) continue
    if (onlyInsideCompound(t, term)) continue
    return subject
  }
  return null
}

/**
 * Every subject mentioned in a longer piece of text, most specific first.
 *
 * Used on briefs and design plans, which is why the ambiguous terms are skipped
 * here and not in `matchSubject`: this reads prose about a UI, where 「テーブル」
 * means a data table, and that reads the name of a thing, where it means
 * furniture.
 */
export function matchSubjects(text: string): string[] {
  if (!text) return []
  const t = text.toLowerCase()
  const out: string[] = []
  for (const { subject, term } of ORDERED) {
    if (AMBIGUOUS_IN_BRIEF.has(term)) continue
    if (!out.includes(subject) && t.includes(term)) out.push(subject)
  }
  return out
}

/**
 * Words that name a whole CATEGORY rather than a photographable subject.
 *
 * 「アパレルのECサイト」 names no subject: `apparel` is the category, and the
 * things under it are `tshirt`, `knitwear`, `jeans`. So the matcher found
 * nothing, no photographs were offered, and a clothing shop was built with no
 * clothes in it — measured on a real run, 37 files and zero images.
 *
 * Deliberately separate from SUBJECT_TERMS and consulted only after it: a brief
 * that names an actual garment must still get that garment rather than a spread
 * of the whole category. This is the fallback for a brief that describes its
 * domain without naming a single thing in it, which is how most briefs are
 * written.
 */
const CATEGORY_TERMS: Record<string, string[]> = {
  apparel: ['アパレル', 'ファッション', '衣料', '洋服', '服飾', 'apparel', 'fashion', 'clothing'],
  food: ['食品', '食料', 'グルメ', '惣菜', 'food', 'grocery', '飲食料品'],
  drink: ['飲料', 'ドリンク', 'beverage', 'drink'],
  home: ['家具', 'インテリア', '生活雑貨', '日用品', 'furniture', 'interior', 'homeware'],
  electronics: ['家電', 'ガジェット', '電化製品', 'electronics', 'gadget'],
  beauty: ['美容', 'ビューティ', 'beauty', 'cosmetics'],
  leisure: ['趣味', 'ホビー', 'レジャー', 'hobby', 'leisure'],
  stationery: ['文具', 'ステーショナリー', 'stationery'],
}

const CATEGORY_ORDERED: { category: string; term: string }[] = Object.entries(CATEGORY_TERMS)
  .flatMap(([category, terms]) => terms.map((term) => ({ category, term: term.toLowerCase() })))
  .sort((a, b) => b.term.length - a.term.length)

/** Every category a piece of text names, most specific first. */
export function matchCategories(text: string): string[] {
  if (!text) return []
  const t = text.toLowerCase()
  const out: string[] = []
  for (const { category, term } of CATEGORY_ORDERED) {
    if (!out.includes(category) && t.includes(term)) out.push(category)
  }
  return out
}
