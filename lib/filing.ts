// Smart filing for the generic vault: suggestions from text read on the phone. The person always checks them.
import { cleanText, findDocDate, guessKind, suggestTitle, type KindRule } from "./vault-core";
import { GENERIC_RULES } from "./rules";

export type Filing = { kind: string; docDate: string | null; title: string; text: string };

/** kindLabel turns a kind into display text (e.g. a translation); defaults to a capitalised kind name. */
export function fileFromText(
  raw: string,
  opts: { rules?: readonly KindRule[]; kindLabel?: (kind: string) => string; today?: Date } = {},
): Filing {
  const text = cleanText(raw);
  const kind = guessKind(text, opts.rules ?? GENERIC_RULES);
  const docDate = findDocDate(text, opts.today ?? new Date());
  const label = opts.kindLabel ? opts.kindLabel(kind) : kind.charAt(0).toUpperCase() + kind.slice(1);
  return { kind, docDate, title: suggestTitle(label, docDate), text };
}
