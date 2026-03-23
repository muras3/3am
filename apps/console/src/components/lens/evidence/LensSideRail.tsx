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
        ? "Narrative confidence is still being refined from the current evidence mix."
        : "Confidence will appear here once multiple evidence surfaces agree on the same explanation.",
      kind: "confidence",
    },
    {
      title: "Uncertainty",
      text: baselineState === "unavailable"
        ? "No expected baseline is attached yet, so treat observed slowdowns and failures as directional rather than fully comparative."
        : "Open questions will stay pinned here while the system separates confirmed facts from still-unresolved possibilities.",
      kind: "uncertainty",
    },
    {
      title: "Dependencies in Scope",
      text: "Dependency notes stay pinned here as trace and log correlation confirms what is truly involved.",
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
