import { diagnose, generateConsoleNarrative } from "3am-diagnosis";
import type { StorageDriver, Incident } from "../storage/interface.js";
import type { TelemetryStoreDriver } from "../telemetry/interface.js";
import { buildReasoningStructure } from "../domain/reasoning-structure-builder.js";
import { getReceiverLlmSettings } from "./llm-settings.js";
import { notifyDiagnosisComplete } from "../notification/index.js";

export class DiagnosisRunner {
  constructor(
    private readonly storage: StorageDriver,
    private readonly telemetryStore: TelemetryStoreDriver,
  ) {}

  private async resolveLocale(): Promise<"en" | "ja"> {
    const stored = await this.storage.getSettings("locale");
    return stored === "ja" ? "ja" : "en";
  }

  async run(incidentId: string): Promise<boolean> {
    const llmSettings = await getReceiverLlmSettings(this.storage);
    if (llmSettings.mode === "manual") {
      console.warn("[diagnosis-runner] manual mode enabled — skipping automatic diagnosis");
      return false;
    }

    try {
      const incident = await this.storage.getIncident(incidentId);
      if (!incident) {
        console.warn(`[diagnosis-runner] incident ${incidentId} not found`);
        return false;
      }

      const locale = await this.resolveLocale();

      // Stage 1: incident diagnosis (DIAGNOSIS_MODEL env var overrides default model)
      const diagnosisModel = process.env["DIAGNOSIS_MODEL"];
      const result = diagnosisModel
        ? await diagnose(incident.packet, {
            model: diagnosisModel,
            locale,
            provider: llmSettings.provider,
            allowSubprocessProviders: false,
            allowLocalHttpProviders: false,
          })
        : await diagnose(incident.packet, {
            locale,
            provider: llmSettings.provider,
            allowSubprocessProviders: false,
            allowLocalHttpProviders: false,
          });
      await this.storage.appendDiagnosis(incidentId, result);
      await notifyDiagnosisComplete(this.storage, incident.packet, incidentId, result);

      // Stage 2: console narrative generation (graceful degradation — failure does not affect stage 1)
      await this.runNarrativeGeneration(incident, result, locale);

      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[diagnosis-runner] diagnosis failed for ${incidentId}: ${errMsg}`);
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

    const locale = await this.resolveLocale();
    return this.runNarrativeGeneration(incident, incident.diagnosisResult, locale);
  }

  /**
   * Stage 2: generate console narrative from stage 1 result + receiver context.
   * Wrapped in try/catch — if this fails, stage 1 result is already stored.
   * Includes 1 automatic retry on LLM failure.
   */
  private async runNarrativeGeneration(
    incident: Incident,
    diagnosisResult: Awaited<ReturnType<typeof diagnose>>,
    locale?: "en" | "ja",
  ): Promise<boolean> {
    const incidentId = incident.incidentId;
    const llmSettings = await getReceiverLlmSettings(this.storage);
    try {
      const reasoningStructure = await buildReasoningStructure(
        incident,
        this.telemetryStore,
      );

      const tryGenerate = async (): Promise<void> => {
        // NARRATIVE_MODEL env var overrides default model (e.g. claude-haiku-4-5-20251001 for faster execution)
        const narrativeModel = process.env["NARRATIVE_MODEL"];
        const narrativeOpts = {
          ...(narrativeModel ? { model: narrativeModel } : {}),
          ...(locale ? { locale } : {}),
          provider: llmSettings.provider,
          allowSubprocessProviders: false,
          allowLocalHttpProviders: false,
        };
        const narrative = Object.keys(narrativeOpts).length > 0
          ? await generateConsoleNarrative(diagnosisResult, reasoningStructure, narrativeOpts)
          : await generateConsoleNarrative(diagnosisResult, reasoningStructure);
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
