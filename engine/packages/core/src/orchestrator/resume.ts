import { WorkflowSchema, type JobMetadata, type JobStatus } from "@app-story/contracts";
import type { LoadedProduct } from "@app-story/products";
import { AppStoryError, slugify } from "@app-story/shared";
import type { ProviderOverrides } from "../pipeline/providers";
import { listTakes } from "../pipeline/takes";
import { storeFor, type Runtime } from "../runtime";
import type { Store } from "../store/store";
import { generateDemo } from "./generate";
import { redoVideo } from "./redo";

export interface ResumeRequest {
  product: LoadedProduct;
  outputDir: string;
  /** The failed video's job id. Default: the product's newest failed video. */
  jobId?: string;
  headless?: boolean;
  logLevel?: string;
  providers?: ProviderOverrides;
  /** Default: the process's runtime. */
  runtime?: Runtime;
  onJobCreated?: (job: { id: string; paths: { root: string } }) => void;
}

const DONE = new Set<JobStatus>(["success", "success_with_warnings"]);

/**
 * Pick a failed video up where it stopped, without paying for the AI planning again.
 *
 * - Failed after its recording was kept (while rendering): rendered again from it, as `redo`
 *   does. No browser, no AI.
 * - Failed earlier, but after its plan passed the safety checks: that plan is replayed. The
 *   narration comes from the cache, the browser records again, and the plan is saved for
 *   reuse once the video passes.
 * - Failed before it had a plan: nothing to resume; the error says so.
 */
export async function resumeDemo(request: ResumeRequest): Promise<JobMetadata> {
  const { product } = request;
  const store = storeFor(request.outputDir, request.runtime);
  const failed = request.jobId ? store.getJob(request.jobId) : newestFailed(store, product.id);
  if (!failed) {
    throw new AppStoryError("CONFIG_INVALID", request.jobId ? `There is no video ${request.jobId}.` : `No video of ${product.id} has failed.`, {
      hint: `See them all: npx app-story history ${product.id}`,
    });
  }
  if (failed.product_id !== product.id) {
    throw new AppStoryError("CONFIG_INVALID", `The video ${failed.job_id} belongs to ${failed.product_id}, not ${product.id}.`);
  }
  if (DONE.has(failed.status)) {
    throw new AppStoryError("CONFIG_INVALID", `The video ${failed.job_id} did not fail, so there is nothing to resume.`, {
      hint: `To make it again with the current look: npx app-story redo ${product.id} ${failed.job_id}`,
    });
  }

  const common = { product, outputDir: request.outputDir, logLevel: request.logLevel, runtime: request.runtime, onJobCreated: request.onJobCreated };
  const takes = await listTakes(store.dataDir, product.id);
  if (takes.some((t) => t.jobId === failed.job_id)) return redoVideo({ ...common, jobId: failed.job_id });

  const plan = WorkflowSchema.safeParse(store.getRecordJson(failed.job_id, "plan"));
  if (!plan.success) {
    throw new AppStoryError("CONFIG_INVALID", `The video ${failed.job_id} failed before its plan was ready, so there is nothing to resume.`, {
      hint: `Make it again: npx app-story ${product.id}${failed.objective ? ` "${failed.objective}"` : ""}`,
    });
  }
  const objective = failed.objective ?? plan.data.objective;
  return generateDemo({
    ...common,
    objective,
    name: store.getJobName(failed.job_id) ?? slugify(objective),
    plan: plan.data,
    resumedFrom: failed.job_id,
    kind: failed.kind ?? undefined,
    headless: request.headless,
    providers: request.providers,
  });
}

function newestFailed(store: Store, productId: string): JobMetadata | undefined {
  return store.listJobs({ productId }).find((m) => !DONE.has(m.status) && m.mode !== "redo");
}
