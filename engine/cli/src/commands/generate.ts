import { Command, Option } from "commander";
import { TTS_PROVIDERS } from "@demoforge/contracts";
import { generateDemo, planFromReleaseNotes } from "@demoforge/core";
import { loadScenario, objectiveForAllFeatures, objectiveForFeature, type LoadedProduct } from "@demoforge/products";
import { DemoForgeError, mapWithConcurrency, slugify } from "@demoforge/shared";
import { globals, openProduct, type ProviderFlags } from "../context";
import { bold, dim, exitCodeFor, green, printJob, yellow } from "../output";

interface GenerateOptions extends ProviderFlags {
  product: string;
  objective?: string;
  scenario?: string;
  all?: boolean;
  features?: string | boolean;
  each?: boolean;
  template?: string;
  duration?: string;
  audience?: string;
  saveScenario?: boolean;
  allowUnapproved?: boolean;
  headed?: boolean;
  concurrency: string;
}

export function providerFlags(cmd: Command): Command {
  return cmd
    .addOption(new Option("--ai-provider <provider>", "override the AI provider for this run").choices(["anthropic", "openai"]))
    .option("--ai-model <model>", "override the AI model for this run")
    .addOption(new Option("--tts-provider <provider>", "override the text-to-speech provider").choices([...TTS_PROVIDERS]));
}

export function generateCommand(): Command {
  const cmd = new Command("generate")
    .description("Generate a demo video from your release notes, an objective (AI-planned) or a saved scenario")
    .requiredOption("--product <id>", "product id")
    .option("--objective <text>", "what to demonstrate, in plain language (Mode A)")
    .option("--scenario <id>", "saved scenario to replay (Mode B)")
    .option("--all", "generate every approved scenario of the product")
    .option("--features [file]", "make the video from release notes in any format (default: products/<id>/features.md)")
    .option("--each", "with --features: one video per feature instead of one video for all of them")
    .option("--template <name>", "video template (minimal, modern-saas, product-update, tutorial, feature-highlight)")
    .option("--duration <seconds>", "target video length in seconds")
    .option("--audience <text>", "who the video is for")
    .option("--save-scenario", "save the AI-planned workflow as an unapproved scenario for review")
    .option("--allow-unapproved", "allow a scenario that has not been approved (review runs only)")
    .option("--headed", "show the browser window while working")
    .option("--concurrency <n>", "parallel jobs with --all or --features --each", "1");
  providerFlags(cmd);

  return cmd.action(async (opts: GenerateOptions, command: Command) => {
    const chosen = [opts.objective, opts.scenario, opts.all, opts.features].filter(Boolean).length;
    if (chosen !== 1) {
      throw new DemoForgeError("CONFIG_INVALID", "Use exactly one of --features, --objective, --scenario or --all.");
    }
    if (opts.each && !opts.features) {
      throw new DemoForgeError("CONFIG_INVALID", "--each only works together with --features.");
    }
    const { outputDir, logLevel } = globals(command);
    const product = await openProduct(command, opts.product, opts);
    const common = {
      product,
      outputDir,
      logLevel,
      templateName: opts.template,
      durationS: opts.duration ? Number(opts.duration) : undefined,
      audience: opts.audience,
      headless: opts.headed ? false : undefined,
      allowUnapproved: opts.allowUnapproved,
      onJobCreated: (job: { id: string; paths: { root: string } }) => console.log(dim(`Job ${job.id} → ${job.paths.root}`)),
    };

    if (opts.all) {
      const approved: string[] = [];
      for (const id of product.scenarios) {
        const w = await loadScenario(product, id).catch(() => undefined);
        if (w?.approved) approved.push(id);
        else console.log(yellow(`! skipping ${id} (not approved or invalid)`));
      }
      if (approved.length === 0) throw new DemoForgeError("SCENARIO_NOT_FOUND", "No approved scenarios to generate.");
      const results = await mapWithConcurrency(approved, Math.max(1, Number(opts.concurrency)), (scenarioId) =>
        generateDemo({ ...common, scenarioId }),
      );
      results.forEach(printJob);
      process.exitCode = results.every((m) => exitCodeFor(m) === 0) ? 0 : 1;
      return;
    }

    if (opts.features) {
      const jobs = await featureJobs(product, opts.features, Boolean(opts.each), logLevel);
      const results = await mapWithConcurrency(jobs, Math.max(1, Number(opts.concurrency)), (job) =>
        generateDemo({ ...common, ...job, saveScenario: opts.saveScenario }),
      );
      results.forEach(printJob);
      process.exitCode = results.every((m) => exitCodeFor(m) === 0) ? 0 : 1;
      return;
    }

    const metadata = await generateDemo({ ...common, objective: opts.objective, scenarioId: opts.scenario, saveScenario: opts.saveScenario });
    printJob(metadata);
    process.exitCode = exitCodeFor(metadata);
  });
}

/** Let the AI pick the demoable features from the release notes, then make one job for all or one per feature. */
async function featureJobs(
  product: LoadedProduct,
  file: string | boolean,
  each: boolean,
  logLevel: string | undefined,
): Promise<{ objective: string; name: string }[]> {
  const { notes, plan, costUsd } = await planFromReleaseNotes({ product, file: typeof file === "string" ? file : undefined, logLevel });
  // A file passed on the command line replaces products/<id>/features.md as AI context too.
  product.features = notes;

  const cost = costUsd ? ` · $${costUsd.toFixed(3)}` : "";
  console.log(`${bold(`Features to demo${plan.title ? ` from ${plan.title}` : ""}`)} ${dim(`(read from ${notes.file}${cost})`)}`);
  for (const f of plan.features) console.log(`  ${green("•")} ${f.title}`);
  for (const s of plan.skipped) console.log(dim(`  - skipped: ${s.item} (${s.reason})`));
  console.log();

  if (each) {
    return plan.features.map((f) => ({ objective: objectiveForFeature(f), name: slugify(f.title) }));
  }
  const name = plan.title ?? (plan.features.length === 1 ? (plan.features[0] as { title: string }).title : "features");
  return [{ objective: objectiveForAllFeatures(plan), name: slugify(name) }];
}
