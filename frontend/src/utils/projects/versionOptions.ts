import type { DropdownOption } from '../../components/common/Dropdown';
import type { VersionEntry } from '../../hooks/useHistory';

/**
 * The version list, as menu rows.
 *
 * Two places choose a version — the preview toolbar and each side of the
 * comparison — and they had two copies of the same three decisions: that the
 * empty id means the live document, that the numbering counts down from the
 * newest, and how much of a prompt to show. The numbering is the one that
 * matters: `versions` arrives newest-first, so a version's displayed number is
 * `length - index`, and getting that wrong in one place only would put two
 * different names on the same run in the same window.
 *
 * 「現在の状態」 is not among them, because it was the newest version under
 * another name. Every path that changes the document writes one — a generation,
 * a chat edit, and a hand edit through `POST /versions` — so the top of this
 * list IS the live document, and a menu that offered both invited the question
 * of how they differ. They do not.
 *
 * That identity is now something the app maintains rather than something it
 * assumes: the hand-edit save refreshes this list, which it did not do before.
 * Without that the newest entry was the document as it stood BEFORE the edit,
 * and removing the live row would have left the edited document unreachable
 * from the menu that is supposed to list everything.
 *
 * The prompt becomes the description rather than the label. In a native select
 * it had to be the label — there was nowhere else to put it — so every option
 * read `v3 — ECサイトのトップ…` and the trigger, being narrow, showed the part
 * they all share. As a description it is fully visible in the menu while the
 * trigger shows the only thing that distinguishes a version at a glance.
 */
export function versionOptions(versions: VersionEntry[]): DropdownOption[] {
  return versions.map((v, i) => ({
    id: v.versionId,
    label: `v${versions.length - i}`,
    badge: new Date(v.createdAt).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    // Who made it, first, on the runs that record it: on a shared project that is
    // the question the history is opened to answer.
    description: `${v.actorName ? `${v.actorName}：` : ''}${v.prompt || '(プロンプトなし)'}`,
  }));
}
