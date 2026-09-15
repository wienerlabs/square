import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DutyState, TrackedJob } from "./duty.js";

/**
 * The duty's jobs in a file, so a restart does not forget them (square#348).
 *
 * One JSON document, rewritten whole on every change through a rename, so a
 * process killed mid-write leaves the previous document and never half of
 * one. What is kept is what the chain does not carry: the job id, the
 * capability the job bought (the spec is hashed on chain) and the budget the
 * allowance counts. Everything else the duty reads back from the chain.
 *
 * Node only, by way of `node:fs`; it is exported from `@squaresdk/policy/node`
 * rather than the package's root so a browser bundle of the root never sees
 * it. The app keeps no duty.
 */
export function fileDutyState(path: string): DutyState {
  return {
    load(): TrackedJob[] {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const parsed = JSON.parse(text) as { jobs?: unknown };
      if (!Array.isArray(parsed.jobs)) throw new Error(`${path}: expected { jobs: [...] }`);
      return parsed.jobs.map((entry, index) => {
        const row = entry as { jobId?: unknown; category?: unknown; budget?: unknown };
        if (typeof row.jobId !== "string" || !/^\d+$/.test(row.jobId)) throw new Error(`${path}: jobs[${index}].jobId is not a decimal job id`);
        if (row.category !== undefined && typeof row.category !== "string") throw new Error(`${path}: jobs[${index}].category is not a string`);
        if (row.budget !== undefined && (typeof row.budget !== "string" || !/^\d+$/.test(row.budget))) throw new Error(`${path}: jobs[${index}].budget is not a decimal amount`);
        return {
          jobId: BigInt(row.jobId),
          category: row.category,
          ...(row.budget !== undefined ? { budget: BigInt(row.budget) } : {}),
        };
      });
    },
    save(jobs: TrackedJob[]): void {
      const document = {
        jobs: jobs.map((job) => ({
          jobId: job.jobId.toString(),
          ...(job.category !== undefined ? { category: job.category } : {}),
          ...(job.budget !== undefined ? { budget: job.budget.toString() } : {}),
        })),
      };
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
      renameSync(temporary, path);
    },
  };
}
