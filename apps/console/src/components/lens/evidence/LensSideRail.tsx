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
): SideNote[] {
  return [
    {
      title: "Confidence",
      text: diagnosisState === "ready"
        ? "Narrative confidence is still being prepared."
        : "Confidence will populate when deterministic evidence is strong enough to summarize.",
      kind: "confidence",
    },
    {
      title: "Uncertainty",
      text: baselineState === "unavailable"
        ? "No expected baseline is available yet, so deviations should be interpreted cautiously."
        : "Narrative uncertainty will appear here once the diagnosis is available.",
      kind: "uncertainty",
    },
    {
      title: "Affected Dependencies",
      text: "Dependency notes will stay pinned here as evidence linking matures.",
      kind: "dependency",
    },
  ];
}

/**
 * LensSideRail — right 240px panel rendering contextual side notes.
 * "primary" variant gets teal border + teal title.
 */
export function LensSideRail({ notes, diagnosisState, baselineState }: Props) {
  const renderedNotes = notes.length > 0
    ? notes
    : buildPlaceholderNotes(diagnosisState, baselineState);

  return (
    <aside className="lens-ev-side" aria-label="Contextual notes">
      {renderedNotes.map((note) => (
        <SideNoteCard key={note.title} note={note} />
      ))}
    </aside>
  );
}
