import { diagnose } from "@3amoncall/diagnosis";
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

      const result = await diagnose(incident.packet);
      await this.storage.appendDiagnosis(incidentId, result);
      return true;
    } catch (err) {
      console.error(`[diagnosis-runner] diagnosis failed for ${incidentId}:`, err);
      return false;
    }
  }
}
