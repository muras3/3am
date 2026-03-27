import { useTranslation } from "react-i18next";
import type { SideNote } from "../../../api/curated-types.js";

interface Props {
  notes: SideNote[];
  diagnosisState?: "ready" | "pending" | "unavailable";
  baselineState?: "ready" | "insufficient" | "unavailable";
}

interface SideNoteCardProps {
  note: SideNote;
}

function SideNoteCard({ note }: SideNoteCardProps) {
  const isPrimary = note.kind === "confidence";

  return (
    <div
      className={`lens-ev-side-note${isPrimary ? " lens-ev-side-note-primary" : ""}`}
      role="complementary"
      aria-label={note.title}
    >
      <div className="lens-ev-side-note-title">{note.title}</div>
      <p className="lens-ev-side-note-content">{note.text}</p>
    </div>
  );
}

function buildPlaceholderNotes(
  diagnosisState: Props["diagnosisState"],
  baselineState: Props["baselineState"],
  t: (key: string) => string,
): SideNote[] {
  return [
    {
      title: t("evidence.sideRail.confidence"),
      text: diagnosisState === "ready"
        ? t("evidence.sideRail.confidenceReady")
        : t("evidence.sideRail.confidencePending"),
      kind: "confidence",
    },
    {
      title: t("evidence.sideRail.uncertainty"),
      text: baselineState === "unavailable"
        ? t("evidence.sideRail.uncertaintyUnavailable")
        : t("evidence.sideRail.uncertaintyDefault"),
      kind: "uncertainty",
    },
    {
      title: t("evidence.sideRail.dependencies"),
      text: t("evidence.sideRail.dependenciesDefault"),
      kind: "dependency",
    },
  ];
}

/**
 * LensSideRail — right 240px panel rendering contextual side notes.
 * "primary" variant gets teal border + teal title.
 */
export function LensSideRail({ notes, diagnosisState, baselineState }: Props) {
  const { t } = useTranslation();
  const renderedNotes = notes.length > 0
    ? notes
    : buildPlaceholderNotes(diagnosisState, baselineState, t);

  return (
    <aside className="lens-ev-side" aria-label={t("evidence.sideRail.label")}>
      {renderedNotes.map((note) => (
        <SideNoteCard key={note.title} note={note} />
      ))}
    </aside>
  );
}
