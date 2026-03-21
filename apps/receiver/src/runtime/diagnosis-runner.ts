import { diagnose, generateConsoleNarrative } from "@3amoncall/diagnosis";
import type { ReasoningStructure } from "@3amoncall/core";
import type { StorageDriver } from "../storage/interface.js";

export class DiagnosisRunner {
  constructor(private readonly storage: StorageDriver) {}

  async run(incidentId: string): Promise<boolean> {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      console.warn("[diagnosis-runner] ANTHROPIC_API_KEY not set — skipping diagnosis");
      return false;
    }

    try {
      const incident = await this.storage.getIncident(incidentId);
      if (!incident) {
        console.warn(`[diagnosis-runner] incident ${incidentId} not found`);
        return false;
      }

      // Stage 1: incident diagnosis
      const result = await diagnose(incident.packet);
      await this.storage.appendDiagnosis(incidentId, result);

      // Stage 2: console narrative generation (graceful degradation — failure does not affect stage 1)
      await this.runNarrativeGeneration(incidentId, result);

      return true;
    } catch (err) {
      console.error(`[diagnosis-runner] diagnosis failed for ${incidentId}:`, err);
      return false;
    }
  }

  /**
   * Stage 2: generate console narrative from stage 1 result + receiver context.
   * Wrapped in try/catch — if this fails, stage 1 result is already stored.
   */
  private async runNarrativeGeneration(
    incidentId: string,
    diagnosisResult: Awaited<ReturnType<typeof diagnose>>,
  ): Promise<void> {
    try {
      const reasoningStructure = await this.buildReasoningStructure(incidentId);
      if (!reasoningStructure) {
        console.warn(`[diagnosis-runner] could not build reasoning structure for ${incidentId} — skipping narrative`);
        return;
      }

      const narrative = await generateConsoleNarrative(diagnosisResult, reasoningStructure);
      await this.storage.appendConsoleNarrative(incidentId, narrative);
    } catch (err) {
      console.warn(`[diagnosis-runner] narrative generation failed for ${incidentId} (stage 1 result preserved):`, err);
    }
  }

  /**
   * Build ReasoningStructure from incident data.
   * TODO: This is a placeholder. The full implementation belongs to the receiver plan
   * and will compute proof refs, blast radius, absence candidates, etc. from
   * TelemetryStore data. For now, returns null to skip narrative generation.
   */
  private async buildReasoningStructure(
    _incidentId: string,
  ): Promise<ReasoningStructure | null> {
    // Receiver plan will implement this.
    // Until then, narrative generation is skipped gracefully.
    return null;
  }
}
