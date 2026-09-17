import { logger } from '../utils/logger.js';
import { firstJsonObject } from '../utils/model-json.js';
import type { ContentImage } from '../utils/content-images.js';

/**
 * The only place a content image is looked at.
 *
 * Everything downstream reads captions, not pixels — see the header of
 * `content-images.ts` for why. This is the single call that turns one into the
 * other, and keeping it single is the point: an image costs roughly
 * `width * height / 750` tokens to look at, so five photos shown to the five
 * design specialists and the build is about 39,000 tokens on a run whose median
 * is 154,000. Shown once, it is one call whatever the pipeline does afterwards.
 *
 * All the images go in ONE request rather than one call each. They are described
 * relative to each other — "the same mug, on a different background" is a useful
 * caption and an image alone cannot produce it — and one request also means one
 * ledger entry to read when someone asks what captioning costs.
 *
 * ## Never a gate
 *
 * A caption that fails costs the user nothing. The images are still embedded,
 * still placed, and still get alt text; the model is simply told less about
 * them. `contentImageDirective` renders an empty caption as 「写真」, so the
 * whole feature degrades to "here are N pictures, place them" rather than
 * failing. Every path here returns rather than throws.
 */

/** Kept short on purpose: these are alt-text-length descriptions, not prose. */
const MAX_CAPTION_TOKENS = 700;

// The bound lives with the shape it bounds; a user-written description is
// subject to the same one.
import { MAX_CAPTION_CHARS } from '../utils/content-images.js';

const SYSTEM = `画像に写っているものを、UIに配置するための説明として1枚ずつ書き、
その画像の使われ方を依頼文から判断します。

各画像について、次を1文で：
- 何が写っているか（主題を具体的に。「商品」ではなく「白いマグカップ」）
- UIのどこに置くのが自然か（商品カード、ヘッダーのロゴ、記事のヘッダー画像、人物のアバターなど）

あわせて用途を判定します:
- "content" … その画像そのものを画面に表示したい（商品写真、ロゴ、記事の挿絵）
- "reference" … その画像の見た目を真似したい（配色・レイアウト・トーンの参考）

用途の判定はきびしく。**依頼文が参考にすると明示しているときだけ "reference"**。
「この配色で」「このデザインを踏襲して」「この雰囲気に寄せて」などが根拠になります。
写真が上手いから、雰囲気が良いから、は根拠になりません。迷ったら "content"。
参考にすると読めるものが複数あっても、最も強く指示されている1枚だけを "reference" に。

守ること:
- ユーザーの依頼文と同じ言語で書く。判断できなければ日本語。
- 説明は1文、60文字程度。これはalt属性になります。
- 写真の印象や雰囲気を語らない。何であるかと、どこに置くかだけ。
- 読み取れない画像は説明を "" にする。推測で埋めない。

出力は次のJSONだけ。前後に文章を書かない。
{"captions":["1枚目の説明","2枚目の説明"],"roles":["content","reference"]}`;

/**
 * Fills `caption` on each image, in place of the empty string it arrived with.
 *
 * @param invoke the model call, taking the system prompt and the user content
 *        blocks — image blocks plus one text block. Passed in rather than built
 *        here so the caller owns the model choice and the ledger stage.
 */
export async function captionImages(
  images: ContentImage[],
  prompt: string,
  invoke: (system: string, content: Array<Record<string, unknown>>, maxTokens: number) => Promise<string>
): Promise<void> {
  /*
   * Only the ones nobody has described.
   *
   * A picture the user captioned needs no vision call: they know what it is and
   * the model can only guess. When every attachment carries a description this
   * returns before making a call at all, which is the cheapest the feature gets.
   */
  const undescribed = images.filter((im) => !im.fromUser);
  if (undescribed.length === 0) {
    if (images.length > 0) {
      logger.info('Every supplied image was described by the user; no captioning call', {
        count: images.length,
      });
    }
    return;
  }

  const content: Array<Record<string, unknown>> = undescribed.map((im) => ({
    type: 'image',
    source: { type: 'base64', media_type: im.mediaType, data: im.base64 },
  }));
  content.push({
    type: 'text',
    text:
      `依頼文: "${prompt.slice(0, 400)}"\n\n`
      + `上の${images.length}枚について、この順番で説明を書いてください。`,
  });

  try {
    const reply = await invoke(SYSTEM, content, MAX_CAPTION_TOKENS);
    const parsed = firstJsonObject<{ captions?: unknown; roles?: unknown }>(reply);
    const captions = Array.isArray(parsed?.captions) ? parsed.captions : [];
    const roles = Array.isArray(parsed?.roles) ? parsed.roles : [];
    if (captions.length === 0) {
      logger.info('Image captions came back empty; placing the images undescribed', {
        count: images.length,
      });
      return;
    }
    /*
     * Assigned by position, and only as far as both lists go.
     *
     * A model that returns three captions for four images has described the
     * first three — assigning them by index keeps those and leaves the fourth
     * blank, which is exactly the degradation this is meant to have. Reading the
     * list as "some captions for some images" and pairing them any other way
     * would put the wrong description on the right picture, which is worse than
     * no description at all: the alt text would then be a false statement.
     */
    for (let i = 0; i < undescribed.length; i += 1) {
      const c = typeof captions[i] === 'string' ? (captions[i] as string).trim() : '';
      undescribed[i].caption = c.slice(0, MAX_CAPTION_CHARS);
      /*
       * Anything that is not the exact word is content.
       *
       * The default has to be the safe one, because the two failure directions
       * are not symmetrical. A reference read as content is a picture placed on
       * a screen, which the user can see and ask about. Content read as a
       * reference is a product photo deciding the palette of the whole build —
       * and it is expensive as well as wrong, since a reference is the one image
       * every stage of the design phase actually looks at.
       */
      undescribed[i].role = roles[i] === 'reference' ? 'reference' : 'content';
    }
    const described = images.filter((im) => im.caption).length;
    logger.info('Captioned the supplied images', {
      count: undescribed.length,
      describedByUser: images.length - undescribed.length,
      described,
      captions: images.map((im) => im.caption || '(none)'),
      roles: images.map((im) => im.role),
    });
  } catch (e) {
    // See the header: a failure here must not cost the user their pictures.
    logger.warn('Could not caption the supplied images; placing them undescribed', {
      count: undescribed.length,
      error: String(e),
    });
  }
}
