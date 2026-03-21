import { diagnose, generateConsoleNarrative } from "@3amoncall/diagnosis";
import type { StorageDriver, Incident } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildReasoningStructure } from "../domain/reasoning-structure-builder.js";

export class DiagnosisRunner {
  constructor(
    private readonly storage: StorageDriver,
    private readonly telemetryStore: TelemetryStoreDriver,
  ) {}

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
      await this.runNarrativeGeneration(incident, result);

      return true;
    } catch (err) {
      console.error(`[diagnosis-runner] diagnosis failed for ${incidentId}:`, err);
      return false;
    }
  }

  /**
   * Re-run stage 2 only for an incident that already has a stage 1 result.
   * CLI / ops use only — not exposed to console UI.
   */
  async rerunNarrative(incidentId: string): Promise<boolean> {
    const incident = await this.storage.getIncident(incidentId);
    if (!incident) {
      console.warn(`[diagnosis-runner] incident ${incidentId} not found`);
      return false;
    }
    if (!incident.diagnosisResult) {
      console.warn(`[diagnosis-runner] incident ${incidentId} has no stage 1 result — cannot re-run narrative`);
      return false;
    }

    return this.runNarrativeGeneration(incident, incident.diagnosisResult);
  }

  /**
   * Stage 2: generate console narrative from stage 1 result + receiver context.
   * Wrapped in try/catch — if this fails, stage 1 result is already stored.
   * Includes 1 automatic retry on LLM failure.
   */
  private async runNarrativeGeneration(
    incident: Incident,
    diagnosisResult: Awaited<ReturnType<typeof diagnose>>,
  ): Promise<boolean> {
    const incidentId = incident.incidentId;
    try {
      const reasoningStructure = await buildReasoningStructure(
        incident,
        this.telemetryStore,
      );

      const tryGenerate = async (): Promise<void> => {
        const narrative = await generateConsoleNarrative(diagnosisResult, reasoningStructure);
        await this.storage.appendConsoleNarrative(incidentId, narrative);
      };

      try {
        await tryGenerate();
        return true;
      } catch (firstErr) {
        console.warn(`[diagnosis-runner] narrative generation failed for ${incidentId}, retrying once:`, firstErr);
        try {
          await tryGenerate();
          return true;
        } catch (retryErr) {
          console.error(`[diagnosis-runner] narrative generation retry also failed for ${incidentId} (stage 1 result preserved):`, retryErr);
          return false;
        }
      }
    } catch (err) {
      console.warn(`[diagnosis-runner] could not build reasoning structure for ${incidentId}:`, err);
      return false;
    }
  }
}
