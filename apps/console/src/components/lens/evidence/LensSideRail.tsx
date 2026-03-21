import type { SideNote } from "../../../api/curated-types.js";

interface Props {
  notes: SideNote[];
}

interface SideNoteCardProps {
  note: SideNote;
}

function SideNoteCard({ note }: SideNoteCardProps) {
  const isPrimary = note.variant === "primary";

  return (
    <div
      className={`lens-ev-side-note${isPrimary ? " lens-ev-side-note-primary" : ""}`}
      role="complementary"
      aria-label={note.title}
    >
      <div className="lens-ev-side-note-title">{note.title}</div>
      <p className="lens-ev-side-note-content">{note.content}</p>
    </div>
  );
}

/**
 * LensSideRail — right 240px panel rendering contextual side notes.
 * "primary" variant gets teal border + teal title.
 */
export function LensSideRail({ notes }: Props) {
  if (notes.length === 0) return null;

  return (
    <aside className="lens-ev-side" aria-label="Contextual notes">
      {notes.map((note) => (
        <SideNoteCard key={note.title} note={note} />
      ))}
    </aside>
  );
}
