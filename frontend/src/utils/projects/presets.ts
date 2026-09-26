/**
 * The design presets, and how a stored one is read back.
 *
 * Moved out of the component that used to render them. The settings drawer held
 * a second preset chooser — the composer has had its own デザイン menu all along
 * — and when the drawer went, the values it named had to outlive it: every
 * project record carries a preset, and reading one back is not a thing the UI
 * layer should own.
 */
export interface Preset {
  id: string;
  /** Full name, shown in the composer's デザイン menu. */
  label: string;
  /** Compact name, shown on the chip row in the chat composer. */
  chip: string;
  description: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'none',
    label: 'プリセットなし',
    chip: 'None',
    description: 'AIが自由にデザインを決定',
  },
  {
    id: 'digital-agency',
    label: 'デジタル庁デザインシステム',
    chip: 'DA',
    description: '行政サービス向け / キーカラー #0017C1・黒と黄のフォーカス・確認画面つきの手続き',
  },
  {
    id: 'carbon',
    label: 'Carbon（IBM）',
    chip: 'Carbon',
    description: '業務システム・データの多い管理画面 / 角丸なし・グレーの階層・ブルー #0F62FE',
  },
  {
    id: 'spindle',
    label: 'Spindle（Ameba）',
    chip: 'Spindle',
    description: '一般利用者向けのサービス / モバイル優先・丸いボタン・グリーン #298737',
  },
  {
    id: 'material3',
    label: 'Material Design 3',
    chip: 'M3',
    description: 'スマホ中心のアプリ / トーンで分ける面・丸いボタン・パープル #6750A4',
  },
];

/** Preset ids the UI accepts. Anything else falls back to 'none'. */
export const ALLOWED_PRESETS = PRESETS.map((p) => p.id);

/**
 * A stored preset, read back as something that can still be selected.
 *
 * `system:<uuid>` — one of the user's own imported design systems — used to
 * survive this untouched, so the record kept naming the system it was built
 * against. It does not survive now, and the reason is the whole of it: the
 * importer, the store and the routes between them are gone, so the server
 * resolves any `system:` preset to 'none' before the build starts. Carrying the
 * value through would leave the composer's デザイン menu showing no selection
 * for a preset that is not being applied either — a blank control claiming a
 * choice that no longer exists anywhere.
 */
export function normalizePreset(preset: string | undefined): string {
  return preset && ALLOWED_PRESETS.includes(preset) ? preset : 'none';
}
