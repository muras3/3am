import type { ChipVM } from "../../lib/viewmodels/index.js";
import { Chip } from "../common/Chip.js";

interface Props {
  headline: string;
  chips: ChipVM[];
}

export function WhatHappened({ headline, chips }: Props) {
  return (
    <section className="section-what" data-section="what-broke">
      <div className="headline">{headline}</div>
      <div className="impact-chips">
        {chips.map((chip, i) => (
          <Chip key={i} label={chip.label} variant={chip.kind} />
        ))}
      </div>
    </section>
  );
}
